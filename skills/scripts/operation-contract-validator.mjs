/** Dependency-free validator for the generated operation contract dialect. */
export function validateOperationContract(contract,value){
  const errors=[];
  const byteBudgets=(contract.runtimeRefinements??[]).filter(rule=>rule.kind==="maxJsonBytes");
  validateRuntimeRefinements(byteBudgets,value,errors);
  if(errors.length>0)return {valid:false,errors};
  validateJsonSchema(contract.input,value,"$",contract.input,errors);
  if(errors.length===0)validateRuntimeRefinements(
    (contract.runtimeRefinements??[]).filter(rule=>rule.kind!=="maxJsonBytes"),
    value,
    errors,
  );
  return {valid:errors.length===0,errors};
}

/**
 * Resolve a literal or compact generated fixture from operation-contracts.
 * Generated descriptors are strict and bounded so artifact validation cannot
 * be turned into an unbounded allocator.
 */
export function materializeOperationFixture(contract,fixture){
  const hasValue=Object.hasOwn(fixture??{},"value");
  const hasMaterializer=Object.hasOwn(fixture??{},"materializer");
  if(hasValue===hasMaterializer)throw new Error("fixture must contain exactly one of value or materializer");
  if(hasValue)return fixture.value;
  const descriptor=fixture.materializer;
  if(!descriptor||typeof descriptor!=="object"||Array.isArray(descriptor))throw new Error("fixture materializer must be an object");
  const keys=Object.keys(descriptor).sort();
  const boundedInteger=(value,minimum,maximum)=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum;
  if(descriptor.kind==="ticket-proposal-budget/v1"){
    const expected=["changeCount","kind","outcomeLength","rationaleLength"];
    if(JSON.stringify(keys)!==JSON.stringify(expected))throw new Error("fixture materializer contains unsupported fields");
    if(!boundedInteger(descriptor.changeCount,1,200)
      ||!boundedInteger(descriptor.outcomeLength,1,20_000)
      ||!boundedInteger(descriptor.rationaleLength,0,20_000)){
      throw new Error("fixture materializer parameters are out of bounds");
    }
    const positive=contract?.fixtures?.positive;
    if(!positive||positive.kind!=="graph_change"||!Array.isArray(positive.changes))throw new Error("ticket proposal materializer requires a graph_change positive fixture");
    const outcome="x".repeat(descriptor.outcomeLength);
    const rationale="y".repeat(descriptor.rationaleLength);
    return {
      ...structuredClone(positive),
      changes:Array.from({length:descriptor.changeCount},(_,index)=>({
        op:"create",
        localRef:`budget-${index}`,
        definition:{
          outcome,
          parent:null,
          dependsOn:[{
            target:{kind:"ticket",ticketId:`TKT-${index}`},
            ...(rationale?{rationale}:{}),
          }],
        },
      })),
    };
  }
  if(descriptor.kind==="ticket-proposal-validation-budget/v1"){
    const expected=["detailLength","findingCount","kind"];
    if(JSON.stringify(keys)!==JSON.stringify(expected))throw new Error("fixture materializer contains unsupported fields");
    if(!boundedInteger(descriptor.findingCount,1,200)
      ||!boundedInteger(descriptor.detailLength,1,20_000)){
      throw new Error("fixture materializer parameters are out of bounds");
    }
    const positive=contract?.fixtures?.positive;
    if(!positive||!Array.isArray(positive.checks)||positive.checks.length===0)throw new Error("ticket proposal validation materializer requires a validation positive fixture");
    return {
      ...structuredClone(positive),
      findings:Array.from({length:descriptor.findingCount},(_,index)=>({
        localRef:`budget-finding-${index}`,
        checkLocalRef:positive.checks[index%positive.checks.length].localRef,
        subject:{kind:"proposal"},
        impact:"advisory",
        code:"budget-fixture",
        summary:"Bounded generated validation finding",
        detail:"x".repeat(descriptor.detailLength),
        evidenceRefs:["proposal:budget-fixture"],
      })),
    };
  }
  throw new Error(`unsupported fixture materializer ${descriptor.kind??""}`);
}

export function validateRuntimeRefinements(refinements,value,errors=[]){
  let objects;
  for(const rule of refinements){
    if(rule.kind==="maxJsonBytes"){
      if(!isJsonWithinByteBudget(value,rule.maximum))errors.push({path:"$",message:rule.message,refinementId:rule.id});
      continue;
    }
    if(rule.kind==="maxNestedArrayItems"){
      const parents=Array.isArray(value?.[rule.parentField])?value[rule.parentField]:[];
      const count=parents.reduce((total,item)=>total+(Array.isArray(item?.[rule.childField])?item[rule.childField].length:0),0);
      if(count>rule.maximum)errors.push({path:`$.${rule.parentField}`,message:rule.message,refinementId:rule.id});
      continue;
    }
    if(rule.kind==="ticketProposalValidationCoherence"){
      const checks=Array.isArray(value?.checks)?value.checks:[];
      const findings=Array.isArray(value?.findings)?value.findings:[];
      const checkRefs=checks.map(check=>check?.localRef);
      const checkCodes=checks.map(check=>check?.code);
      const findingRefs=findings.map(finding=>finding?.localRef);
      const checkByRef=new Map(checks.map(check=>[check?.localRef,check]));
      const blockingByCheck=new Map();
      let coherent=
        new Set(checkRefs).size===checkRefs.length
        &&new Set(checkCodes).size===rule.codes.length
        &&rule.codes.every(code=>checkCodes.includes(code))
        &&new Set(findingRefs).size===findingRefs.length;
      for(const finding of findings){
        const check=checkByRef.get(finding?.checkLocalRef);
        if(!check){coherent=false;continue;}
        if(finding?.impact==="blocking"){
          blockingByCheck.set(
            finding.checkLocalRef,
            (blockingByCheck.get(finding.checkLocalRef)??0)+1,
          );
          if(check.outcome==="passed")coherent=false;
        }
      }
      for(const check of checks){
        if(check?.outcome!=="passed"
          &&(blockingByCheck.get(check?.localRef)??0)===0)coherent=false;
      }
      if(!coherent)errors.push({
        path:"$",
        message:rule.message,
        refinementId:rule.id,
      });
      continue;
    }
    if(rule.kind!=="fieldCompare"){errors.push({path:"$",message:`unsupported runtime refinement ${rule.kind}`,refinementId:rule.id});continue;}
    if(!objects){objects=[];walkObjects(value,"$",objects);}
    for(const {value:object,path} of objects){
      if(!rule.matchFields.every(field=>Object.hasOwn(object,field)))continue;
      const left=object[rule.leftField],right=object[rule.rightField];
      const valid=rule.operator==="gte"?typeof left==="number"&&typeof right==="number"&&left>=right:rule.operator==="notEqual"?left!==right:false;
      if(!valid)errors.push({path,message:rule.message,refinementId:rule.id});
    }
  }
  return errors;
}

/** Exact, early-exit JSON UTF-8 budget check without building serialized JSON. */
export function isJsonWithinByteBudget(value,maximum){
  if(!Number.isSafeInteger(maximum)||maximum<0)return false;
  let remaining=maximum;
  const consume=bytes=>(remaining-=bytes)>=0;
  const consumeString=text=>{
    if(!consume(2))return false;
    for(let index=0;index<text.length;index++){
      const code=text.charCodeAt(index);
      if(code===0x22||code===0x5c){if(!consume(2))return false;}
      else if(code===0x08||code===0x09||code===0x0a||code===0x0c||code===0x0d){if(!consume(2))return false;}
      else if(code<=0x1f){if(!consume(6))return false;}
      else if(code<=0x7f){if(!consume(1))return false;}
      else if(code<=0x7ff){if(!consume(2))return false;}
      else if(code>=0xd800&&code<=0xdbff){
        const next=text.charCodeAt(index+1);
        if(next>=0xdc00&&next<=0xdfff){index++;if(!consume(4))return false;}
        else if(!consume(6))return false;
      }else if(code>=0xdc00&&code<=0xdfff){if(!consume(6))return false;}
      else if(!consume(3))return false;
    }
    return true;
  };
  const active=new WeakSet();
  const frames=[{kind:"value",value}];
  try{
    while(frames.length){
      const frame=frames.pop();
      if(frame.kind==="array"){
        if(frame.index>=frame.value.length){active.delete(frame.value);if(!consume(1))return false;continue;}
        if(frame.index>0&&!consume(1))return false;
        const child=frame.value[frame.index];
        frames.push({...frame,index:frame.index+1},{kind:"value",value:child});
        continue;
      }
      if(frame.kind==="object"){
        let entry=frame.keys.next();
        while(!entry.done&&!Object.prototype.propertyIsEnumerable.call(frame.value,entry.value))entry=frame.keys.next();
        if(entry.done){active.delete(frame.value);if(!consume(1))return false;continue;}
        if(frame.wroteProperty&&!consume(1))return false;
        if(!consumeString(entry.value)||!consume(1))return false;
        const child=frame.value[entry.value];
        frames.push({...frame,wroteProperty:true},{kind:"value",value:child});
        continue;
      }
      const item=frame.value;
      if(item===null){if(!consume(4))return false;}
      else if(typeof item==="string"){if(!consumeString(item))return false;}
      else if(typeof item==="boolean"){if(!consume(item?4:5))return false;}
      else if(typeof item==="number"){
        const encoded=Number.isFinite(item)?JSON.stringify(item):"null";
        if(!encoded||!consume(encoded.length))return false;
      }else if(Array.isArray(item)){
        if(active.has(item)||!consume(1))return false;
        active.add(item);frames.push({kind:"array",value:item,index:0});
      }else if(typeof item==="object"){
        const prototype=Object.getPrototypeOf(item);
        if((prototype!==Object.prototype&&prototype!==null)||active.has(item)||!consume(1))return false;
        active.add(item);
        frames.push({kind:"object",value:item,keys:(function*(){for(const key in item)yield key;})(),wroteProperty:false});
      }else return false;
    }
  }catch{return false;}
  return true;
}

function walkObjects(value,path,out){
  if(!value||typeof value!=="object")return;
  if(!Array.isArray(value))out.push({value,path});
  if(Array.isArray(value))value.forEach((child,index)=>walkObjects(child,`${path}[${index}]`,out));
  else for(const [key,child] of Object.entries(value))walkObjects(child,`${path}.${key}`,out);
}

function validateJsonSchema(schema,value,path,root,errors){
  if(schema.$ref){const target=schema.$ref.split("/").slice(1).reduce((x,key)=>x?.[key.replaceAll("~1","/").replaceAll("~0","~")],root);return validateJsonSchema(target,value,path,root,errors);}
  if(schema.allOf)for(const candidate of schema.allOf)validateJsonSchema(candidate,value,path,root,errors);
  if(schema.anyOf&&!matches(schema.anyOf,value,path,root))errors.push({path,message:"does not match any allowed shape"});
  if(schema.oneOf&&schema.oneOf.filter(candidate=>isValid(candidate,value,path,root)).length!==1)errors.push({path,message:"must match exactly one allowed shape"});
  if(schema.not&&isValid(schema.not,value,path,root))errors.push({path,message:"matches a forbidden shape"});
  if(schema.if){const branch=isValid(schema.if,value,path,root)?schema.then:schema.else;if(branch)validateJsonSchema(branch,value,path,root,errors);}
  if(Object.hasOwn(schema,"const")&&!Object.is(schema.const,value))errors.push({path,message:`must equal ${JSON.stringify(schema.const)}`});
  if(schema.enum&&!schema.enum.includes(value))errors.push({path,message:`must be one of ${schema.enum.join(", ")}`});
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if(schema.type&&!types.some(type=>isType(type,value))){errors.push({path,message:`must be ${types.join(" or ")}`});return;}
  if(typeof value==="string"){
    const characterLength=[...value].length;
    if(schema.minLength!==undefined&&characterLength<schema.minLength)errors.push({path,message:"string too short"});
    if(schema.maxLength!==undefined&&characterLength>schema.maxLength)errors.push({path,message:"string too long"});
    if(schema.pattern&&!new RegExp(schema.pattern,"u").test(value))errors.push({path,message:"string does not match pattern"});
  }
  if(typeof value==="number"){
    if(schema.minimum!==undefined&&value<schema.minimum)errors.push({path,message:"number below minimum"});
    if(schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum)errors.push({path,message:"number below exclusive minimum"});
    if(schema.maximum!==undefined&&value>schema.maximum)errors.push({path,message:"number above maximum"});
    if(schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum)errors.push({path,message:"number above exclusive maximum"});
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems)errors.push({path,message:"too few items"});
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)errors.push({path,message:"too many items"});
    if(schema.uniqueItems&&new Set(value.map(JSON.stringify)).size!==value.length)errors.push({path,message:"items must be unique"});
    if(schema.items)value.forEach((item,index)=>validateJsonSchema(schema.items,item,`${path}[${index}]`,root,errors));
  }
  if(value&&typeof value==="object"&&!Array.isArray(value)){
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))errors.push({path:`${path}.${key}`,message:"required"});
    for(const [key,dependencies] of Object.entries(schema.dependentRequired??{}))if(Object.hasOwn(value,key))for(const dependency of dependencies)if(!Object.hasOwn(value,dependency))errors.push({path:`${path}.${dependency}`,message:`required when ${key} is present`});
    if(schema.additionalProperties===false)for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties??{},key))errors.push({path:`${path}.${key}`,message:"unexpected property"});
    for(const [key,child] of Object.entries(schema.properties??{}))if(Object.hasOwn(value,key))validateJsonSchema(child,value[key],`${path}.${key}`,root,errors);
  }
}

function isValid(schema,value,path,root){const errors=[];validateJsonSchema(schema,value,path,root,errors);return errors.length===0;}
function matches(schemas,value,path,root){return schemas.some(schema=>isValid(schema,value,path,root));}
function isType(type,value){return type==="null"?value===null:type==="array"?Array.isArray(value):type==="object"?Boolean(value)&&typeof value==="object"&&!Array.isArray(value):type==="integer"?Number.isInteger(value):typeof value===type;}
