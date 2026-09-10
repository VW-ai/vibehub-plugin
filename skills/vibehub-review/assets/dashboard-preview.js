/* Read-only canonical previews. Content is always text or an inert image;
   repository HTML, scripts, and remote embeds never execute. */
(() => {
  'use strict';
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  function inline(node,text) {
    for(const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
      node.append(part.startsWith('`')?el('code',part.slice(1,-1)):part.startsWith('**')?el('strong',part.slice(2,-2)):document.createTextNode(part));
    }
    return node;
  }
  function table(container,rows) {
    const wrap=el('div'), node=el('table');wrap.className='preview-table';wrap.tabIndex=0;wrap.setAttribute('aria-label','Scrollable data table');
    rows.slice(0,201).forEach((cells,index)=>{const row=el('tr');cells.slice(0,40).forEach(cell=>{const td=inline(el(index?'td':'th'),cell);if(!index)td.scope='col';row.append(td);});node.append(row);});
    wrap.append(node);container.append(wrap);
    if(rows.length>201||rows.some(row=>row.length>40))container.append(el('p','Table preview limited to 200 data rows and 40 columns. Use Source for the full file.'));
  }
  function parseDelimited(text,delimiter=',') {
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++) {
      const char=text[i];
      if(char==='"'&&(quoted||cell==='')) {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&char===delimiter){row.push(cell);cell='';}
      else if(!quoted&&(char==='\n'||char==='\r')){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
      else cell+=char;
    }
    if(cell||row.length){row.push(cell);rows.push(row);}return rows;
  }
  function markdown(container,text) {
    const lines=text.replace(/\r\n/g,'\n').split('\n'), limit=Math.min(lines.length,2000);
    const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());
    for(let i=0;i<limit;i++) {
      const line=lines[i];if(!line.trim())continue;
      const fence=line.match(/^\s*(`{3,}|~{3,})(\w*)/);
      if(fence){const code=[];while(++i<limit&&!lines[i].trim().startsWith(fence[1]))code.push(lines[i]);
        if(['mermaid','plantuml','dot'].includes(fence[2]))container.append(el('p',`${fence[2]} diagram source · rendered diagram preview is not available yet.`));
        const pre=el('pre');pre.append(el('code',code.join('\n')));container.append(pre);continue;}
      if(i+1<limit&&line.includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {const rows=[cells(line)];i++;while(i+1<limit&&lines[i+1].includes('|')&&lines[i+1].trim())rows.push(cells(lines[++i]));table(container,rows);continue;}
      const heading=line.match(/^(#{1,6})\s+(.+)/);if(heading){container.append(inline(el(`h${Math.min(heading[1].length+2,6)}`),heading[2]));continue;}
      const list=line.match(/^\s*(?:[-*+] |\d+\. )(.+)/);if(list){const node=el('ul');node.append(inline(el('li'),list[1]));container.append(node);continue;}
      container.append(inline(el(line.startsWith('> ')?'blockquote':'p'),line.replace(/^> /,'')));
    }
    if(lines.length>limit)container.append(el('p','Preview limited to 2,000 lines. Use Source for the full file.'));
  }
  function render(container,data,source=false) {
    container.replaceChildren();
    if(data.kind==='image') {const img=el('img');img.alt=`Preview of ${data.ref}`;img.src=`data:${data.mime};base64,${data.content}`;img.addEventListener('error',()=>container.replaceChildren(el('p','This image could not be displayed.')));container.append(img);return;}
    if(!source&&['.md','.markdown'].includes(data.extension)){markdown(container,data.content);return;}
    if(!source&&['.csv','.tsv'].includes(data.extension)){table(container,parseDelimited(data.content,data.extension==='.tsv'?'\t':','));return;}
    let text=data.content;if(!source&&data.extension==='.json'){try{text=JSON.stringify(JSON.parse(text),null,2);}catch{/* Preserve invalid source for inspection. */}}
    const pre=el('pre');pre.append(el('code',text));container.append(pre);
  }
  globalThis.VibeHubPreview={render,parseDelimited};
})();
