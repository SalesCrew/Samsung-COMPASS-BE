export type CellComment={text:string;sheet:string;cell:string};
type XmlNode={localName:string|null;getAttribute(name:string):string|null;textContent:string|null;getElementsByTagName(name:string):ArrayLike<XmlNode>};
type XmlTree={getElementsByTagName(name:string):ArrayLike<XmlNode>};
const nodes=(tree:XmlTree,name:string)=>Array.from(tree.getElementsByTagName('*')).filter(n=>n.localName===name);
const clean=(value:string)=>value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
const validRef=(ref:string)=>/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(ref);

/** Read only the comment parts linked by this worksheet. No people, VML or external links. */
export function readSheetComments(path:string,sheet:string,archive:Record<string,Uint8Array>,read:(path:string)=>XmlTree):Map<string,CellComment[]>{
  const slash=path.lastIndexOf('/'),rels=path.slice(0,slash)+'/_rels/'+path.slice(slash+1)+'.rels';
  if(!archive[rels])return new Map();
  const classic=new Map<string,string[]>(),threaded=new Map<string,string[]>();
  for(const rel of nodes(read(rels),'Relationship')){
    const type=rel.getAttribute('Type')??'',modern=type.endsWith('/threadedComment');
    if(!modern&&!type.endsWith('/comments')||rel.getAttribute('TargetMode')==='External')continue;
    const target=new URL(rel.getAttribute('Target')??'','https://workbook.local/'+path);
    if(target.origin!=='https://workbook.local'||target.search||target.hash)continue;
    const part=target.pathname.slice(1);
    if(!/^xl\/(?:comments[^/]*\.xml|comments\/[^/]+\.xml|threadedComments\/[^/]+\.xml)$/.test(part)||!archive[part])continue;
    const doc=read(part),authors=nodes(doc,'author').map(n=>n.textContent??'');
    for(const comment of nodes(doc,modern?'threadedComment':'comment')){
      const ref=(comment.getAttribute('ref')??'').replace(/\$/g,'').toUpperCase();
      if(!validRef(ref))continue;
      if(modern&&!threaded.has(ref))threaded.set(ref,[]);
      let text=clean(modern?nodes(comment,'text').map(n=>n.textContent??'').join('\n'):nodes(comment,'text').flatMap(n=>nodes(n,'t')).map(n=>n.textContent??'').join(''));
      // Classic Excel notes can repeat their author as a text prefix.
      const author=authors[Number(comment.getAttribute('authorId'))];
      if(!modern&&author&&text.startsWith(author+':'))text=clean(text.slice(author.length+1));
      if(!text)continue;
      if(text.length>8000)throw new Error('Ein Excel-Zellkommentar ist zu lang. Bitte auf höchstens 8.000 Zeichen kürzen.');
      const store=modern?threaded:classic,values=store.get(ref)??[];
      if(!values.includes(text))values.push(text);
      if(values.length>32)throw new Error('Zu viele Kommentare an einer Excel-Zelle. Bitte den Thread kürzen.');
      store.set(ref,values);
      if(classic.size+threaded.size>10000)throw new Error('Zu viele Excel-Zellkommentare.');
    }
  }
  // Modern comments are the authoritative text; their classic fallback is not another note.
  for(const [ref,texts]of classic)if(!threaded.has(ref)&&texts.some(t=>/^\[(?:Threaded comment|Threadkommentar)\]/i.test(t))){
    throw new Error('Ein Excel-Threadkommentar kann nicht gelesen werden. Bitte die Datei in einer aktuellen Excel-Version öffnen, neu speichern und erneut wählen.');
  }
  return new Map([...new Set([...classic.keys(),...threaded.keys()])].map(ref=>[ref,(threaded.get(ref)??classic.get(ref)??[]).map(text=>({text,sheet,cell:ref}))]));
}

export function cellComments(...cells:({comments?:CellComment[]}|undefined)[]):CellComment[]{
  const seen=new Set<string>();
  return cells.flatMap(c=>c?.comments??[]).filter(c=>{const key=JSON.stringify(c);if(seen.has(key))return false;seen.add(key);return true;});
}
