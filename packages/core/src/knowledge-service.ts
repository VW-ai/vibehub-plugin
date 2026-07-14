import crypto from "node:crypto";
import type { Db } from "./db.js";
import { canonicalRepoPath } from "./scope-registry.js";
import {
  KB_RELATION_TYPES,
  KB_SPEC_STATES,
  KB_SPEC_TYPES,
  type KbRelationType,
  type KbSpecState,
  type KbSpecType,
} from "./contract/kb-types.js";
import {operationContextSchema,operationInputSchemas,type OperationName} from "./operation-contracts.js";

export class KnowledgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly nextSafeActions: string[] = [],
  ) { super(message); }
}

export interface MutationContext {
  actor: string;
  taskId?: string;
  requestId: string;
  now: string;
}
export interface KbEvidenceInput {
  id?: string; sourceType: string; sourceRef: string; exactQuote?: string;
  evidenceRef?: string; contentHash?: string; confidence?: number;
}
export interface KbAnchorInput {
  file: string; symbol?: string; lineStart?: number; lineEnd?: number; contentHash?: string;
}
export interface KbRelationInput { toSpecId: string; type: KbRelationType; rationale?: string }
export interface DraftSpecInput {
  id: string; featureId?: string; type: KbSpecType; summary: string; detail?: string;
  priority?: string; layer?: string; domain?: string; tags?: string[];
  evidence: KbEvidenceInput[]; anchors?: KbAnchorInput[]; relations?: KbRelationInput[];
}
export interface DraftBatchInput { idempotencyKey: string; specs: DraftSpecInput[] }

// better-sqlite3 has no row-shape inference; each query below fixes its own
// aliases and this internal bag is immediately projected into public DTOs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const json = <T>(value: string): T => JSON.parse(value) as T;
const stable = (value: unknown): string => {
  const walk = (v: unknown): unknown => Array.isArray(v) ? v.map(walk) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, walk(x)])) : v;
  return JSON.stringify(walk(value));
};
const hash = (value: unknown): string => crypto.createHash("sha256").update(stable(value)).digest("hex");
const oneOf = <T extends string>(value: unknown, values: readonly T[], field: string): T => {
  if (typeof value !== "string" || !values.includes(value as T)) throw new KnowledgeError("validation_error", `invalid ${field}`, { field, value });
  return value as T;
};
const required = (value: unknown, field: string, maxLength=20_000): string => {
  if (typeof value !== "string" || value === "" || value !== value.trim() || [...value].length>maxLength) throw new KnowledgeError("validation_error", `${field} must be a canonical nonblank string`, { field });
  return value;
};
const optionalCanonical=(value:unknown,field:string,maxLength:number):void=>{if(value!==undefined&&value!==null)required(value,field,maxLength);};
const canonicalPath=(value:unknown,field:string):string=>{const raw=required(value,field,1000);let normalized="";try{normalized=canonicalRepoPath(raw);}catch{throw new KnowledgeError("validation_error",`${field} must be a canonical repo-relative path`,{field});}if(normalized!==raw)throw new KnowledgeError("validation_error",`${field} must be a canonical repo-relative path`,{field});return raw;};
const issueSummary=(issues:Array<{message:string}>):string=>[...new Set(issues.map(issue=>issue.message))].join("; ");
const guardKnowledgeOperation=(name:OperationName,input:unknown):void=>{const parsed=operationInputSchemas[name].safeParse(input);if(!parsed.success)throw new KnowledgeError("validation_error",`validation_error: invalid ${name} input: ${issueSummary(parsed.error.issues)}`,{issues:parsed.error.issues});};
const guardKnowledgeMutation=(name:OperationName,repoId:number,input:unknown,ctx:MutationContext):void=>{guardKnowledgeOperation(name,input);const parsed=operationContextSchema.safeParse({...ctx,repoId});if(!parsed.success)throw new KnowledgeError("validation_error",`validation_error: invalid ${name} context: ${issueSummary(parsed.error.issues)}`,{issues:parsed.error.issues});};

export class KnowledgeService {
  constructor(private readonly db: Db) {}

  status(repoId: number) {
    guardKnowledgeOperation("kb.status",{});
    const states = this.db.prepare(`SELECT state, COUNT(*) AS count FROM kb_specs WHERE repo_id=? GROUP BY state`).all(repoId) as Array<{state:string;count:number}>;
    const active = this.db.prepare(`SELECT a.version_id AS versionId, v.source_kind AS sourceKind, v.created_at AS createdAt,
      v.finalized_at AS finalizedAt, v.checksum FROM repo_active_mapping a JOIN mapping_versions v
      ON v.repo_id=a.repo_id AND v.version_id=a.version_id WHERE a.repo_id=?`).get(repoId) ?? null;
    const unplaced = (this.db.prepare(`SELECT COUNT(*) AS count FROM kb_specs s LEFT JOIN repo_active_mapping a ON a.repo_id=s.repo_id
      LEFT JOIN mapping_version_features f ON f.repo_id=s.repo_id AND f.version_id=a.version_id AND f.feature_id=s.feature_id
      WHERE s.repo_id=? AND s.state='active' AND (s.feature_id IS NULL OR f.feature_id IS NULL)`).get(repoId) as {count:number}).count;
    return { states: Object.fromEntries(states.map(x => [x.state, x.count])), activeMapping: active, unplaced };
  }

  listFeatures(repoId: number, input: { query?: string; path?: string; limit?: number; offset?:number } = {}) {
    guardKnowledgeOperation("kb.feature.list",input);
    optionalCanonical(input.query,"query",300);const q=input.query?.toLowerCase()??null;const p=input.path?canonicalPath(input.path,"path"):null;
    const version = this.activeVersion(repoId);
    if (!version) return [];
    const rows = this.db.prepare(`SELECT f.feature_id AS id, f.parent_feature_id AS parentId, f.name, f.description, f.intent, f.lifecycle,
      COUNT(DISTINCT a.file) AS anchoredFileCount,
      COALESCE(json_group_array(DISTINCT a.file) FILTER (WHERE a.file IS NOT NULL),'[]') AS paths
      FROM mapping_version_features f
      LEFT JOIN mapping_version_anchors a ON a.repo_id=f.repo_id AND a.version_id=f.version_id AND a.feature_id=f.feature_id
      WHERE f.repo_id=? AND f.version_id=?
        AND (? IS NULL OR lower(f.feature_id||' '||f.name||' '||COALESCE(f.description,'')||' '||COALESCE(f.intent,'')) LIKE '%'||?||'%')
        AND (? IS NULL OR EXISTS (SELECT 1 FROM mapping_version_anchors pa WHERE pa.repo_id=f.repo_id AND pa.version_id=f.version_id AND pa.feature_id=f.feature_id AND (pa.file=? OR pa.file LIKE ?||'/%')))
      GROUP BY f.feature_id ORDER BY f.name LIMIT ? OFFSET ?`).all(repoId,version,q,q,p,p,p,Math.min(input.limit??50,200),input.offset??0) as Array<Row>;
    return rows.map((row): Row & {paths:string[];activeMappingVersion:string}=>({...row,paths:json<string[]>(row.paths),activeMappingVersion:version}));
  }

  getFeature(repoId: number, id: string) {
    guardKnowledgeOperation("kb.feature.get",{id});
    const found=this.db.prepare(`SELECT f.feature_id AS id,f.parent_feature_id AS parentId,f.name,f.description,f.intent,f.lifecycle,a.version_id AS activeMappingVersion,
      COUNT(DISTINCT ma.file) AS anchoredFileCount,COALESCE(json_group_array(DISTINCT ma.file) FILTER(WHERE ma.file IS NOT NULL),'[]') AS paths
      FROM repo_active_mapping a JOIN mapping_version_features f ON f.repo_id=a.repo_id AND f.version_id=a.version_id
      LEFT JOIN mapping_version_anchors ma ON ma.repo_id=f.repo_id AND ma.version_id=f.version_id AND ma.feature_id=f.feature_id
      WHERE f.repo_id=? AND f.feature_id=? GROUP BY f.feature_id`).get(repoId,id) as Row|undefined;
    if (!found) {
      const identity = this.db.prepare(`SELECT 1 FROM kb_features WHERE repo_id=? AND feature_id=?`).get(repoId, id);
      if (identity) return { id, unplaced: true, activeMappingVersion: this.activeVersion(repoId), paths: [] };
      throw new KnowledgeError("not_found", `feature not found: ${id}`, {id});
    }
    return {...found,paths:json<string[]>(found.paths),unplaced:false};
  }

  searchSpecs(repoId: number, input: {
    query?: string; paths?: string[]; types?: KbSpecType[]; states?: KbSpecState[]; tags?: string[];
    domain?: string; layer?: string; includeDrafts?: boolean; includeHistory?: boolean; limit?: number;
    offset?:number;
  } = {}) {
    guardKnowledgeOperation("kb.spec.search",input);
    optionalCanonical(input.query,"query",300);input.paths?.forEach(value=>canonicalPath(value,"path"));input.tags?.forEach(value=>required(value,"tag",100));optionalCanonical(input.domain,"domain",200);optionalCanonical(input.layer,"layer",200);
    const allowed = new Set<KbSpecState>(["active"]);
    if (input.includeDrafts) allowed.add("draft");
    if (input.includeHistory) ["stale","superseded","deprecated"].forEach(x => allowed.add(x as KbSpecState));
    if (input.states) { allowed.clear(); input.states.forEach(x => allowed.add(oneOf(x, KB_SPEC_STATES, "state"))); }
    const terms = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const wantedPaths = input.paths ?? [];
    const conditions=[`s.repo_id=?`];const params:unknown[]=[repoId];
    conditions.push(`s.state IN (${[...allowed].map(()=>"?").join(",")})`);params.push(...allowed);
    if(input.types?.length){conditions.push(`r.type IN (${input.types.map(()=>"?").join(",")})`);params.push(...input.types);}
    if(input.tags?.length)for(const tag of input.tags){conditions.push(`EXISTS(SELECT 1 FROM json_each(r.tags) jt WHERE jt.value=?)`);params.push(tag);}
    if(input.domain){conditions.push(`r.domain=?`);params.push(input.domain);}if(input.layer){conditions.push(`r.layer=?`);params.push(input.layer);}
    const termsJson=JSON.stringify(terms),pathsJson=JSON.stringify(wantedPaths);const scoreParams:unknown[]=[];
    const topicScore=terms.length?`COALESCE((SELECT SUM(
      (CASE WHEN instr(lower(r.summary),q.value)>0 THEN 40 ELSE 0 END)+
      (CASE WHEN instr(lower(s.spec_id),q.value)>0 THEN 30 ELSE 0 END)+
      (CASE WHEN instr(lower(r.tags),q.value)>0 THEN 20 ELSE 0 END)+
      (CASE WHEN instr(lower(COALESCE(r.detail,'')),q.value)>0 THEN 10 ELSE 0 END)
      ) FROM json_each(?) q),0)`:"0";
    if(terms.length){scoreParams.push(termsJson);conditions.push(`EXISTS(SELECT 1 FROM json_each(?) q WHERE instr(lower(s.spec_id),q.value)>0 OR instr(lower(r.summary),q.value)>0 OR instr(lower(COALESCE(r.detail,'')),q.value)>0 OR instr(lower(r.tags),q.value)>0)`);params.push(termsJson);}
    const pathScore=wantedPaths.length?`100*(SELECT COUNT(*) FROM json_each(?) wp WHERE EXISTS(SELECT 1 FROM kb_spec_current_anchors sa WHERE sa.repo_id=s.repo_id AND sa.spec_id=s.spec_id AND (sa.file=wp.value OR sa.file LIKE wp.value||'/%')))` : "0";
    if(wantedPaths.length){scoreParams.push(pathsJson);conditions.push(`EXISTS(SELECT 1 FROM kb_spec_current_anchors pa JOIN json_each(?) wp ON pa.file=wp.value OR pa.file LIKE wp.value||'/%' WHERE pa.repo_id=s.repo_id AND pa.spec_id=s.spec_id)`);params.push(pathsJson);}
    const limit=Math.min(input.limit??50,200),offset=input.offset??0;
    const total=(this.db.prepare(`SELECT COUNT(*) AS total
      FROM kb_specs s JOIN kb_spec_revisions r ON r.repo_id=s.repo_id AND r.spec_id=s.spec_id AND r.revision=s.current_revision
      LEFT JOIN repo_active_mapping am ON am.repo_id=s.repo_id LEFT JOIN mapping_version_features f ON f.repo_id=s.repo_id AND f.version_id=am.version_id AND f.feature_id=s.feature_id AND f.lifecycle='active'
      WHERE ${conditions.join(" AND ")}`).get(...params) as {total:number}).total;
    const rows=this.db.prepare(`SELECT s.spec_id AS id,s.feature_id AS featureId,s.state,s.current_revision AS revision,
      r.type,r.summary,r.detail,r.priority,r.layer,r.domain,r.tags,r.producer,r.produced_at AS producedAt,
      CASE WHEN f.feature_id IS NULL THEN 1 ELSE 0 END AS unplaced,(${topicScore})+(${pathScore}) AS score
      FROM kb_specs s JOIN kb_spec_revisions r ON r.repo_id=s.repo_id AND r.spec_id=s.spec_id AND r.revision=s.current_revision
      LEFT JOIN repo_active_mapping am ON am.repo_id=s.repo_id LEFT JOIN mapping_version_features f ON f.repo_id=s.repo_id AND f.version_id=am.version_id AND f.feature_id=s.feature_id AND f.lifecycle='active'
      WHERE ${conditions.join(" AND ")} ORDER BY score DESC,s.spec_id ASC LIMIT ? OFFSET ?`).all(...scoreParams,...params,limit,offset) as Array<Row>;
    const ids=rows.map(r=>r.id as string);const anchorRows=ids.length?this.db.prepare(`SELECT spec_id AS specId,file,symbol,line_start AS lineStart,line_end AS lineEnd,content_hash AS contentHash FROM kb_spec_current_anchors WHERE repo_id=? AND spec_id IN (${ids.map(()=>"?").join(",")}) ORDER BY spec_id,file,symbol`).all(repoId,...ids) as Array<Row>:[];
    const anchorsBy=new Map<string,Array<Row>>();for(const a of anchorRows){const list=anchorsBy.get(a.specId)??[];list.push(a);anchorsBy.set(a.specId,list);}
    const items=rows.map((row): Row & {tags:string[];anchors:ReturnType<KnowledgeService["currentAnchors"]>;matchedPaths:string[];sourceKind:"canonical";unplaced:boolean;score:number} => {
      const anchors = (anchorsBy.get(row.id)??[]) as ReturnType<KnowledgeService["currentAnchors"]>;
      const tags = json<string[]>(row.tags as string);
      const matchedPaths=wantedPaths.filter(p => anchors.some(a => pathContains(p, a.file)));
      return {...row,tags,anchors,matchedPaths,sourceKind:"canonical" as const,unplaced:Boolean(row.unplaced),score:Number(row.score)};
    });
    const count=items.length,hasMore=offset+count<total;
    return {items,count,total,limit,offset,hasMore,truncated:hasMore};
  }

  getSpec(repoId: number, id: string): Row {
    guardKnowledgeOperation("kb.spec.get",{id});
    const base=this.db.prepare(`SELECT s.spec_id AS id,s.feature_id AS featureId,s.state,s.current_revision AS revision,r.type,r.summary,r.detail,r.priority,r.layer,r.domain,r.tags,r.producer,r.produced_at AS producedAt,
      CASE WHEN f.feature_id IS NULL THEN 1 ELSE 0 END AS unplaced FROM kb_specs s JOIN kb_spec_revisions r ON r.repo_id=s.repo_id AND r.spec_id=s.spec_id AND r.revision=s.current_revision
      LEFT JOIN repo_active_mapping am ON am.repo_id=s.repo_id LEFT JOIN mapping_version_features f ON f.repo_id=s.repo_id AND f.version_id=am.version_id AND f.feature_id=s.feature_id AND f.lifecycle='active'
      WHERE s.repo_id=? AND s.spec_id=?`).get(repoId,id) as Row|undefined;
    if (!base) throw new KnowledgeError("not_found", `spec not found: ${id}`, {id});
    const revisions = this.db.prepare(`SELECT revision,type,summary,detail,priority,layer,domain,tags,producer,produced_at AS producedAt
      FROM kb_spec_revisions WHERE repo_id=? AND spec_id=? ORDER BY revision`).all(repoId,id) as Array<Row>;
    const evidence = this.db.prepare(`SELECT evidence_id AS id,revision,source_type AS sourceType,source_ref AS sourceRef,
      exact_quote AS exactQuote,evidence_ref AS evidenceRef,content_hash AS contentHash,confidence,producer,produced_at AS producedAt
      FROM kb_evidence WHERE repo_id=? AND spec_id=? ORDER BY revision,evidence_id`).all(repoId,id);
    const relations = this.db.prepare(`SELECT from_spec_id AS fromSpecId,to_spec_id AS toSpecId,type,rationale,created_at AS createdAt
      FROM kb_spec_relations WHERE repo_id=? AND (from_spec_id=? OR to_spec_id=?) ORDER BY type,from_spec_id,to_spec_id`).all(repoId,id,id);
    const provenance = this.db.prepare(`SELECT operation,actor,task_id AS taskId,request_id AS requestId,at,payload
      FROM kb_provenance_events WHERE repo_id=? AND spec_id=? ORDER BY id`).all(repoId,id) as Array<Row>;
    const revisionAnchors=this.db.prepare(`SELECT revision,file,symbol,line_start AS lineStart,line_end AS lineEnd,content_hash AS contentHash FROM kb_spec_revision_anchors WHERE repo_id=? AND spec_id=? ORDER BY revision,file,symbol`).all(repoId,id) as Array<Row>;
    return {...base,tags:json<string[]>(base.tags),sourceKind:"canonical",unplaced:Boolean(base.unplaced),anchors:this.currentAnchors(repoId,id),revisions: revisions.map(r=>({...r,tags:json<string[]>(r.tags as string),anchors:revisionAnchors.filter(a=>a.revision===r.revision)})),evidence,relations,
      history: provenance.map(p=>({...p,payload:json(p.payload as string)}))};
  }

  traverseRelations(repoId: number, input: {specId:string;direction?:"out"|"in"|"both";types?:KbRelationType[];depth?:number;limit?:number}) {
    guardKnowledgeOperation("kb.relations",input);
    const depth = Math.max(1, Math.min(input.depth ?? 1, 5)); const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    this.ensureSpec(repoId,input.specId); const seen=new Set([input.specId]);const edgeSeen=new Set<string>(); let frontier=[input.specId]; const edges:Array<Row>=[];
    for(let level=1;level<=depth && frontier.length && edges.length<limit;level++){
      const next:string[]=[];
      for(const id of frontier){
        const rows=this.db.prepare(`SELECT from_spec_id AS fromSpecId,to_spec_id AS toSpecId,type,rationale FROM kb_spec_relations
          WHERE repo_id=? AND (from_spec_id=? OR to_spec_id=?)`).all(repoId,id,id) as Array<Row>;
        for(const edge of rows){
          if(input.types?.length && !input.types.includes(edge.type as KbRelationType)) continue;
          if(input.direction==="out" && edge.fromSpecId!==id) continue; if(input.direction==="in" && edge.toSpecId!==id) continue;
          const key=`${edge.fromSpecId}\0${edge.toSpecId}\0${edge.type}`;if(!edgeSeen.has(key)){edgeSeen.add(key);edges.push({...edge,depth:level});} const other=(edge.fromSpecId===id?edge.toSpecId:edge.fromSpecId) as string;
          if(!seen.has(other)){seen.add(other);next.push(other);} if(edges.length>=limit)break;
        }
      } frontier=next;
    } return {root:input.specId,edges,truncated:edges.length>=limit};
  }

  resolveLineage(repoId:number,id:string,maxDepth=100){
    guardKnowledgeOperation("kb.lineage",{id,maxDepth});
    this.ensureSpec(repoId,id); const chain=[id]; const seen=new Set(chain); let current=id;let truncated=false;
    while(chain.length<=maxDepth){ const row=this.db.prepare(`SELECT to_spec_id AS id FROM kb_spec_relations WHERE repo_id=? AND from_spec_id=? AND type='supersedes' ORDER BY to_spec_id LIMIT 1`)
      .get(repoId,current) as {id:string}|undefined; if(!row)break; if(seen.has(row.id))throw new KnowledgeError("relation_cycle","supersession cycle detected",{chain,next:row.id}); seen.add(row.id);chain.push(row.id);current=row.id; }
    if(chain.length>maxDepth){chain.pop();current=chain.at(-1)!;truncated=true;}return {from:id,to:current,chain,maxDepth,truncated};
  }

  anchors(repoId:number,input:{specId?:string;path?:string}){
    guardKnowledgeOperation("kb.anchors",input);
    if(input.specId)return {forward:this.currentAnchors(repoId,input.specId)};
    if(!input.path)throw new KnowledgeError("validation_error","specId or path is required"); const p=canonicalPath(input.path,"path");
    const rows=this.db.prepare(`SELECT spec_id AS specId,file,symbol,line_start AS lineStart,line_end AS lineEnd,content_hash AS contentHash
      FROM kb_spec_current_anchors WHERE repo_id=? ORDER BY spec_id,file`).all(repoId) as Array<{file:string}&Row>;
    return {reverse:rows.filter(x=>pathContains(p,x.file))};
  }

  review(repoId:number,input:{kinds?:string[];limit?:number;offset?:number}={}){
    guardKnowledgeOperation("kb.review",input);
    const kinds=new Set(input.kinds??["low_confidence","conflict","stale","unplaced"]);const branches:string[]=[];const params:unknown[]=[];
    if(kinds.has("low_confidence")){branches.push(`SELECT 'low_confidence' kind,e.spec_id specId,NULL relatedSpecId,e.confidence confidence FROM kb_evidence e JOIN kb_specs s ON s.repo_id=e.repo_id AND s.spec_id=e.spec_id AND s.current_revision=e.revision WHERE e.repo_id=? AND s.state IN ('draft','active','stale') AND e.confidence IS NOT NULL AND e.confidence<0.6`);params.push(repoId);}
    if(kinds.has("conflict")){branches.push(`SELECT 'conflict' kind,r.from_spec_id specId,r.to_spec_id relatedSpecId,NULL confidence FROM kb_spec_relations r JOIN kb_specs f ON f.repo_id=r.repo_id AND f.spec_id=r.from_spec_id JOIN kb_specs t ON t.repo_id=r.repo_id AND t.spec_id=r.to_spec_id WHERE r.repo_id=? AND r.type='conflicts_with' AND f.state IN ('draft','active','stale') AND t.state IN ('draft','active','stale')`);params.push(repoId);}
    if(kinds.has("stale")){branches.push(`SELECT 'stale' kind,spec_id specId,NULL relatedSpecId,NULL confidence FROM kb_specs WHERE repo_id=? AND state='stale'`);params.push(repoId);}
    if(kinds.has("unplaced")){branches.push(`SELECT 'unplaced' kind,s.spec_id specId,NULL relatedSpecId,NULL confidence FROM kb_specs s LEFT JOIN repo_active_mapping am ON am.repo_id=s.repo_id LEFT JOIN mapping_version_features f ON f.repo_id=s.repo_id AND f.version_id=am.version_id AND f.feature_id=s.feature_id AND f.lifecycle='active' WHERE s.repo_id=? AND s.state IN ('draft','active','stale') AND f.feature_id IS NULL`);params.push(repoId);}
    const limit=Math.min(input.limit??100,500),offset=input.offset??0;if(!branches.length)return {items:[],total:0,limit,offset};const union=branches.join(" UNION ALL ");const total=(this.db.prepare(`SELECT COUNT(*) total FROM (${union})`).get(...params) as {total:number}).total;const items=this.db.prepare(`SELECT * FROM (${union}) ORDER BY kind,specId LIMIT ? OFFSET ?`).all(...params,limit,offset) as Array<Row>;return {items,total,limit,offset};
  }

  previewIngest(repoId:number,input:{specs:Array<{summary:string;anchors?:KbAnchorInput[]}>}){
    guardKnowledgeOperation("kb.ingest.preview",input);
    if(!Array.isArray(input.specs)||!input.specs.length||input.specs.length>100)throw new KnowledgeError("validation_error","specs must contain 1..100 items");
    return input.specs.map(candidate=>{ const summary=required(candidate.summary,"summary",300);const lexical=this.db.prepare(`SELECT s.spec_id AS specId,r.summary FROM kb_specs s JOIN kb_spec_revisions r
      ON r.repo_id=s.repo_id AND r.spec_id=s.spec_id AND r.revision=s.current_revision WHERE s.repo_id=? AND lower(r.summary)=lower(?) LIMIT 25`)
      .all(repoId,summary) as Array<Row>;if(candidate.anchors&&candidate.anchors.length>100)throw new KnowledgeError("validation_error","anchors exceed 100");candidate.anchors?.forEach(a=>this.validateAnchor(a)); const anchors=(candidate.anchors??[]).map(a=>({file:canonicalPath(a.file,"anchor.file"),symbol:a.symbol??""}));
      const overlap=anchors.length?this.db.prepare(`SELECT spec_id AS specId,file,symbol FROM kb_spec_current_anchors WHERE repo_id=? AND (${anchors.map(()=>`(file=? AND symbol=?)`).join(" OR ")}) LIMIT 100`).all(repoId,...anchors.flatMap(a=>[a.file,a.symbol])):[]; return {summary,signals:{exactLexical:lexical.slice(0,25),exactAnchorOverlap:overlap}}; });
  }

  applyDraftBatch(repoId:number,input:DraftBatchInput,ctx:MutationContext){
    guardKnowledgeMutation("kb.draft.apply",repoId,input,ctx);
    this.validateContext(ctx,true); required(input.idempotencyKey,"idempotencyKey"); if(!Array.isArray(input.specs)||!input.specs.length)throw new KnowledgeError("validation_error","specs must not be empty");
    const inputHash=hash(input); const existing=this.receipt(repoId,"draft_batch",input.idempotencyKey,inputHash); if(existing)return existing;
    const ids=new Set<string>(); for(const item of input.specs){ this.validateDraft(repoId,item); if(ids.has(item.id))throw new KnowledgeError("validation_error",`duplicate spec id: ${item.id}`);ids.add(item.id); }
    for(const item of input.specs)for(const rel of item.relations??[])if(!ids.has(rel.toSpecId))this.ensureSpec(repoId,rel.toSpecId);
    this.validateRelationPlan(repoId,input.specs.flatMap(s=>(s.relations??[]).map(r=>({from:s.id,to:r.toSpecId,type:r.type}))));
    return this.db.transaction(()=>{ const again=this.receipt(repoId,"draft_batch",input.idempotencyKey,inputHash);if(again)return again;
      for(const item of input.specs)this.insertDraft(repoId,item,ctx);
      for(const item of input.specs)for(const r of item.relations??[])this.db.prepare(`INSERT INTO kb_spec_relations(repo_id,from_spec_id,to_spec_id,type,rationale,created_at) VALUES(?,?,?,?,?,?)`).run(repoId,item.id,r.toSpecId,r.type,r.rationale??null,ctx.now);
      const result={operation:"draft_batch",created:input.specs.map(s=>s.id),idempotencyKey:input.idempotencyKey,inputHash};
      this.storeReceipt(repoId,"draft_batch",input.idempotencyKey,inputHash,result,ctx.now); return result; }).immediate();
  }

  mutate(repoId:number,operation:"promote"|"mark_stale"|"deprecate"|"amend"|"supersede",input:Record<string,unknown>,ctx:MutationContext){
    const operationName=({promote:"kb.promote",mark_stale:"kb.mark-stale",deprecate:"kb.deprecate",amend:"kb.amend",supersede:"kb.supersede"} as const)[operation];guardKnowledgeMutation(operationName,repoId,input,ctx);
    this.validateContext(ctx,false); const key=required(input.idempotencyKey,"idempotencyKey"); const inputHash=hash(input); const cached=this.receipt(repoId,operation,key,inputHash);if(cached)return cached;
    return this.db.transaction(()=>{const again=this.receipt(repoId,operation,key,inputHash);if(again)return again;
      const id=required(input.specId,"specId"); const current=this.specState(repoId,id); let result:Record<string,unknown>={operation,specId:id};
      if(operation==="amend"){const revision=this.amend(repoId,id,input,ctx);result={...result,revision,state:current.state};}
      else if(operation==="supersede"){const replacement=required(input.replacementSpecId,"replacementSpecId");const target=this.specState(repoId,replacement);
        if(target.state==="draft" && input.promoteReplacement===true){this.transition(repoId,replacement,"active",ctx);this.audit(repoId,"promote",replacement,ctx,{state:"active",via:"supersede"});} else if(target.state!=="active")throw new KnowledgeError("replacement_not_active","replacement must be active or explicitly promoted in this transaction",{replacement,state:target.state});
        if(!["active","stale"].includes(current.state))throw new KnowledgeError("invalid_state_transition",`cannot supersede ${current.state} spec`,{id,state:current.state});
        this.validateRelationPlan(repoId,[{from:id,to:replacement,type:"supersedes"}]);
        this.db.prepare(`INSERT INTO kb_spec_relations(repo_id,from_spec_id,to_spec_id,type,rationale,created_at) VALUES(?,?,?,'supersedes',?,?)`)
          .run(repoId,id,replacement,typeof input.rationale==="string"?input.rationale:null,ctx.now); this.transition(repoId,id,"superseded",ctx); result={...result,replacementSpecId:replacement,state:"superseded"};
      } else { const target:KbSpecState=operation==="promote"?"active":operation==="mark_stale"?"stale":"deprecated"; this.transition(repoId,id,target,ctx);result={...result,state:target}; }
      this.audit(repoId,operation,id,ctx,result);this.storeReceipt(repoId,operation,key,inputHash,result,ctx.now);return result;}).immediate();
  }

  private insertDraft(repoId:number,item:DraftSpecInput,ctx:MutationContext){
    this.db.prepare(`INSERT INTO kb_specs(repo_id,spec_id,feature_id,state,current_revision,source_kind,created_at,updated_at) VALUES(?,?,?,'draft',1,'canonical',?,?)`)
      .run(repoId,item.id,item.featureId??null,ctx.now,ctx.now);
    this.db.prepare(`INSERT INTO kb_spec_revisions(repo_id,spec_id,revision,type,summary,detail,priority,layer,domain,tags,producer,produced_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`)
      .run(repoId,item.id,item.type,item.summary,item.detail??null,item.priority??null,item.layer??null,item.domain??null,JSON.stringify(item.tags??[]),ctx.actor,ctx.now);
    for(const [i,e] of item.evidence.entries())this.db.prepare(`INSERT INTO kb_evidence(repo_id,evidence_id,spec_id,revision,source_type,source_ref,exact_quote,evidence_ref,content_hash,confidence,producer,produced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(repoId,e.id??`${item.id}:1:${i+1}`,item.id,1,e.sourceType,e.sourceRef,e.exactQuote??null,e.evidenceRef??null,e.contentHash??null,e.confidence??null,ctx.actor,ctx.now);
    for(const a of item.anchors??[]){const p=canonicalRepoPath(a.file);this.db.prepare(`INSERT INTO kb_spec_revision_anchors(repo_id,spec_id,revision,file,symbol,line_start,line_end,content_hash) VALUES(?,?,1,?,?,?,?,?)`)
      .run(repoId,item.id,p,a.symbol??"",a.lineStart??null,a.lineEnd??null,a.contentHash??null);this.db.prepare(`INSERT INTO kb_spec_current_anchors SELECT * FROM kb_spec_revision_anchors WHERE repo_id=? AND spec_id=? AND revision=1 AND file=? AND symbol=?`).run(repoId,item.id,p,a.symbol??"");}
    this.audit(repoId,"draft_batch",item.id,ctx,{revision:1});
  }

  private amend(repoId:number,id:string,input:Record<string,unknown>,ctx:MutationContext){const cur=this.getSpec(repoId,id);const next=(cur.revision as number)+1;
    const type=input.type===undefined?cur.type:oneOf(input.type,KB_SPEC_TYPES,"type");const summary=input.summary===undefined?cur.summary:required(input.summary,"summary");
    const detail=input.detail===undefined?cur.detail:(input.detail as string|null);if(detail!==null&&detail!==undefined&&(typeof detail!=="string"||[...detail].length>20_000))throw new KnowledgeError("validation_error","detail exceeds its character bound");const priority=input.priority===undefined?cur.priority:input.priority;const layer=input.layer===undefined?cur.layer:input.layer;const domain=input.domain===undefined?cur.domain:input.domain;
    optionalCanonical(priority,"priority",200);optionalCanonical(layer,"layer",200);optionalCanonical(domain,"domain",200);const tags=input.tags===undefined?cur.tags:input.tags;if(!Array.isArray(tags)||tags.length>50||tags.some(x=>{try{required(x,"tag",100);return false;}catch{return true;}}))throw new KnowledgeError("validation_error","tags must be canonical bounded strings");
    this.db.prepare(`INSERT INTO kb_spec_revisions(repo_id,spec_id,revision,type,summary,detail,priority,layer,domain,tags,producer,produced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(repoId,id,next,type,summary,detail,priority,layer,domain,JSON.stringify(tags),ctx.actor,ctx.now);
    const anchors=input.anchors as KbAnchorInput[]|undefined; if(anchors){for(const a of anchors)this.validateAnchor(a);for(const a of anchors){const p=canonicalRepoPath(a.file);this.db.prepare(`INSERT INTO kb_spec_revision_anchors(repo_id,spec_id,revision,file,symbol,line_start,line_end,content_hash) VALUES(?,?,?,?,?,?,?,?)`).run(repoId,id,next,p,a.symbol??"",a.lineStart??null,a.lineEnd??null,a.contentHash??null);}}
    else this.db.prepare(`INSERT INTO kb_spec_revision_anchors SELECT repo_id,spec_id,?,file,symbol,line_start,line_end,content_hash FROM kb_spec_revision_anchors WHERE repo_id=? AND spec_id=? AND revision=?`).run(next,repoId,id,cur.revision);
    const evidence=input.evidence as KbEvidenceInput[]|undefined;if(!Array.isArray(evidence)||!evidence.length)throw new KnowledgeError("validation_error","amend requires evidence for the new immutable revision");for(const [i,e] of evidence.entries()){this.validateEvidence(e);this.db.prepare(`INSERT INTO kb_evidence(repo_id,evidence_id,spec_id,revision,source_type,source_ref,exact_quote,evidence_ref,content_hash,confidence,producer,produced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(repoId,e.id??`${id}:${next}:${i+1}`,id,next,e.sourceType,e.sourceRef,e.exactQuote??null,e.evidenceRef??null,e.contentHash??null,e.confidence??null,ctx.actor,ctx.now);}
    this.db.prepare(`DELETE FROM kb_spec_current_anchors WHERE repo_id=? AND spec_id=?`).run(repoId,id);this.db.prepare(`INSERT INTO kb_spec_current_anchors SELECT * FROM kb_spec_revision_anchors WHERE repo_id=? AND spec_id=? AND revision=?`).run(repoId,id,next);
    const featureId=input.featureId===undefined?cur.featureId:input.featureId;optionalCanonical(featureId,"featureId",200);if(featureId!==null&&featureId!==undefined&&!this.db.prepare(`SELECT 1 FROM kb_features WHERE repo_id=? AND feature_id=?`).get(repoId,featureId))throw new KnowledgeError("not_found",`feature not found: ${String(featureId)}`);
    this.db.prepare(`UPDATE kb_specs SET current_revision=?,feature_id=?,updated_at=? WHERE repo_id=? AND spec_id=?`).run(next,featureId,ctx.now,repoId,id);return next;}

  private validateDraft(repoId:number,item:DraftSpecInput){required(item.id,"id",200);oneOf(item.type,KB_SPEC_TYPES,"type");required(item.summary,"summary",300);optionalCanonical(item.featureId,"featureId",200);optionalCanonical(item.priority,"priority",200);optionalCanonical(item.layer,"layer",200);optionalCanonical(item.domain,"domain",200);if(item.detail!==undefined&&[...item.detail].length>20_000)throw new KnowledgeError("validation_error","detail exceeds its character bound");if(item.tags!==undefined&&(!Array.isArray(item.tags)||item.tags.length>50||item.tags.some(x=>{try{required(x,"tag",100);return false;}catch{return true;}})))throw new KnowledgeError("validation_error","tags must be canonical bounded strings");if(this.db.prepare(`SELECT 1 FROM kb_specs WHERE repo_id=? AND spec_id=?`).get(repoId,item.id))throw new KnowledgeError("already_exists",`spec exists: ${item.id}`);
    if(item.featureId&&!this.db.prepare(`SELECT 1 FROM kb_features WHERE repo_id=? AND feature_id=?`).get(repoId,item.featureId))throw new KnowledgeError("not_found",`feature not found: ${item.featureId}`);if(!Array.isArray(item.evidence)||!item.evidence.length)throw new KnowledgeError("validation_error",`evidence required for ${item.id}`);item.evidence.forEach(e=>this.validateEvidence(e));item.anchors?.forEach(a=>this.validateAnchor(a));item.relations?.forEach(r=>{oneOf(r.type,KB_RELATION_TYPES,"relation type");required(r.toSpecId,"relation.toSpecId",200);if(r.rationale!==undefined&&[...r.rationale].length>20_000)throw new KnowledgeError("validation_error","relation rationale exceeds its character bound");});}
  private validateEvidence(e:KbEvidenceInput){optionalCanonical(e.id,"evidence.id",200);required(e.sourceType,"sourceType",200);required(e.sourceRef,"sourceRef",2000);optionalCanonical(e.evidenceRef,"evidenceRef",2000);optionalCanonical(e.contentHash,"contentHash",200);if(e.exactQuote!==undefined&&[...e.exactQuote].length>20_000)throw new KnowledgeError("validation_error","exactQuote exceeds its character bound");if(e.exactQuote===undefined&&e.evidenceRef===undefined&&e.contentHash===undefined)throw new KnowledgeError("validation_error","evidence needs exactQuote, evidenceRef, or contentHash");if(e.confidence!==undefined&&(e.confidence<0||e.confidence>1))throw new KnowledgeError("validation_error","confidence must be between 0 and 1");}
  private validateAnchor(a:KbAnchorInput){canonicalPath(a.file,"anchor.file");optionalCanonical(a.contentHash,"anchor.contentHash",200);if(a.symbol!==undefined&&[...a.symbol].length>500)throw new KnowledgeError("validation_error","anchor symbol exceeds its character bound");if(a.lineStart!==undefined&&a.lineStart<1)throw new KnowledgeError("validation_error","lineStart must be positive");if(a.lineEnd!==undefined&&(a.lineStart===undefined||a.lineEnd<a.lineStart))throw new KnowledgeError("validation_error","lineEnd requires lineStart and must not precede it");}
  private validateRelationPlan(repoId:number,edges:Array<{from:string;to:string;type:KbRelationType}>){for(const e of edges){if(e.from===e.to)throw new KnowledgeError("relation_cycle","self relation is forbidden",e);if(["supersedes","depends_on"].includes(e.type)){const seen=new Set([e.to]);let frontier=[e.to];while(frontier.length){const x=frontier.shift()!;if(x===e.from)throw new KnowledgeError("relation_cycle",`${e.type} cycle`,e);const next=(this.db.prepare(`SELECT to_spec_id AS id FROM kb_spec_relations WHERE repo_id=? AND from_spec_id=? AND type=?`).all(repoId,x,e.type) as Array<{id:string}>).map(r=>r.id).concat(edges.filter(y=>y.from===x&&y.type===e.type).map(y=>y.to));for(const n of next)if(!seen.has(n)){seen.add(n);frontier.push(n);}}}}}
  private transition(repoId:number,id:string,to:KbSpecState,ctx:MutationContext){const {state}=this.specState(repoId,id);const allowed:Record<KbSpecState,KbSpecState[]>={draft:["active","deprecated"],active:["stale","superseded","deprecated"],stale:["deprecated","superseded"],superseded:[],deprecated:[]};if(!allowed[state].includes(to))throw new KnowledgeError("invalid_state_transition",`cannot transition ${state} to ${to}`,{id,state,to});this.db.prepare(`UPDATE kb_specs SET state=?,updated_at=? WHERE repo_id=? AND spec_id=?`).run(to,ctx.now,repoId,id);}
  private receipt(repoId:number,op:string,key:string,inputHash:string){const row=this.db.prepare(`SELECT input_hash AS inputHash,result FROM kb_mutation_receipts WHERE repo_id=? AND operation=? AND idempotency_key=?`).get(repoId,op,key) as {inputHash:string;result:string}|undefined;if(!row)return null;if(row.inputHash!==inputHash)throw new KnowledgeError("idempotency_conflict","idempotency key was reused with different input",{operation:op,idempotencyKey:key});return json(row.result);}
  private storeReceipt(repoId:number,op:string,key:string,inputHash:string,result:unknown,now:string){this.db.prepare(`INSERT INTO kb_mutation_receipts(repo_id,operation,idempotency_key,input_hash,result,created_at) VALUES(?,?,?,?,?,?)`).run(repoId,op,key,inputHash,JSON.stringify(result),now);}
  private audit(repoId:number,operation:string,specId:string,ctx:MutationContext,payload:unknown){this.db.prepare(`INSERT INTO kb_provenance_events(repo_id,operation,spec_id,actor,task_id,request_id,at,payload) VALUES(?,?,?,?,?,?,?,?)`).run(repoId,operation,specId,ctx.actor,ctx.taskId??null,ctx.requestId,ctx.now,JSON.stringify(payload));}
  private validateContext(ctx:MutationContext,taskRequired:boolean){required(ctx.actor,"actor");required(ctx.requestId,"requestId");required(ctx.now,"now");if(taskRequired)required(ctx.taskId,"taskId");}
  private ensureSpec(repoId:number,id:string){if(!this.db.prepare(`SELECT 1 FROM kb_specs WHERE repo_id=? AND spec_id=?`).get(repoId,id))throw new KnowledgeError("not_found",`spec not found: ${id}`,{id});}
  private specState(repoId:number,id:string){const row=this.db.prepare(`SELECT state FROM kb_specs WHERE repo_id=? AND spec_id=?`).get(repoId,id) as {state:KbSpecState}|undefined;if(!row)throw new KnowledgeError("not_found",`spec not found: ${id}`,{id});return row;}
  private activeVersion(repoId:number){return (this.db.prepare(`SELECT version_id AS id FROM repo_active_mapping WHERE repo_id=?`).get(repoId) as {id:string}|undefined)?.id??null;}
  private featurePlacement(repoId:number,id:string){const v=this.activeVersion(repoId);return v?this.db.prepare(`SELECT feature_id FROM mapping_version_features WHERE repo_id=? AND version_id=? AND feature_id=? AND lifecycle='active'`).get(repoId,v,id):null;}
  private currentAnchors(repoId:number,id:string){return this.db.prepare(`SELECT file,symbol,line_start AS lineStart,line_end AS lineEnd,content_hash AS contentHash FROM kb_spec_current_anchors WHERE repo_id=? AND spec_id=? ORDER BY file,symbol`).all(repoId,id) as Array<{file:string;symbol:string;lineStart:number|null;lineEnd:number|null;contentHash:string|null}>;}
}

function pathContains(query:string,anchor:string):boolean{return anchor===query||anchor.startsWith(query.endsWith("/")?query:`${query}/`)||query.startsWith(anchor.endsWith("/")?anchor:`${anchor}/`);}
