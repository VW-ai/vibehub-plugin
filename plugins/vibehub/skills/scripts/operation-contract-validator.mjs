/** Dependency-free validator for the generated operation contract dialect. */
export function validateOperationContract(contract,value){
  const errors=[];
  validateJsonSchema(contract.input,value,"$",contract.input,errors);
  if(errors.length===0)validateRuntimeRefinements(contract.runtimeRefinements??[],value,errors);
  return {valid:errors.length===0,errors};
}

export function validateRuntimeRefinements(refinements,value,errors=[]){
  const objects=[];walkObjects(value,"$",objects);
  for(const rule of refinements){
    if(rule.kind==="maxJsonBytes"){
      if(new TextEncoder().encode(JSON.stringify(value)).byteLength>rule.maximum)errors.push({path:"$",message:rule.message,refinementId:rule.id});
      continue;
    }
    if(rule.kind==="maxNestedArrayItems"){
      const parents=Array.isArray(value?.[rule.parentField])?value[rule.parentField]:[];
      const count=parents.reduce((total,item)=>total+(Array.isArray(item?.[rule.childField])?item[rule.childField].length:0),0);
      if(count>rule.maximum)errors.push({path:`$.${rule.parentField}`,message:rule.message,refinementId:rule.id});
      continue;
    }
    if(rule.kind!=="fieldCompare"){errors.push({path:"$",message:`unsupported runtime refinement ${rule.kind}`,refinementId:rule.id});continue;}
    for(const {value:object,path} of objects){
      if(!rule.matchFields.every(field=>Object.hasOwn(object,field)))continue;
      const left=object[rule.leftField],right=object[rule.rightField];
      const valid=rule.operator==="gte"?typeof left==="number"&&typeof right==="number"&&left>=right:rule.operator==="notEqual"?left!==right:false;
      if(!valid)errors.push({path,message:rule.message,refinementId:rule.id});
    }
  }
  return errors;
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
