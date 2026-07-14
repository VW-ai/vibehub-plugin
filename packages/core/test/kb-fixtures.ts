import crypto from "node:crypto";
import {computeMappingChecksum,type Db} from "../src/db.js";

/** Test-only deterministic seed. Production callers must use services. */
export function seedActiveMapping(db:Db,repoId:number,features:Array<{id:string;name:string;parentId?:string;anchors?:Array<{file:string;symbol?:string}>}>,now:string):void{
  const version=`test-${crypto.randomUUID()}`;db.prepare(`INSERT INTO mapping_versions(repo_id,version_id,state,source_kind,checksum,created_at,finalized_at) VALUES(?,?,'building','distillation','',?,NULL)`).run(repoId,version,now);
  for(const f of features)db.prepare(`INSERT OR IGNORE INTO kb_features(repo_id,feature_id,created_at) VALUES(?,?,?)`).run(repoId,f.id,now);
  const pending=[...features];while(pending.length){const i=pending.findIndex(f=>!f.parentId||!pending.some(x=>x.id===f.parentId));if(i<0)throw new Error("fixture hierarchy cycle");const [f]=pending.splice(i,1);db.prepare(`INSERT INTO mapping_version_features(repo_id,version_id,feature_id,parent_feature_id,name,lifecycle) VALUES(?,?,?,?,?,'active')`).run(repoId,version,f!.id,f!.parentId??null,f!.name);}
  for(const f of features)for(const a of f.anchors??[])db.prepare(`INSERT INTO mapping_version_anchors(repo_id,version_id,feature_id,file,symbol) VALUES(?,?,?,?,?)`).run(repoId,version,f.id,a.file,a.symbol??"");
  const checksum=computeMappingChecksum(db,repoId,version);db.prepare(`UPDATE mapping_versions SET state='finalized',checksum=?,finalized_at=? WHERE repo_id=? AND version_id=?`).run(checksum,now,repoId,version);db.prepare(`INSERT INTO repo_active_mapping(repo_id,version_id,activated_at) VALUES(?,?,?) ON CONFLICT(repo_id) DO UPDATE SET version_id=excluded.version_id,activated_at=excluded.activated_at`).run(repoId,version,now);
}
