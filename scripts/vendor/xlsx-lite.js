/** Minimal offline OOXML .xlsx writer for Combat Stats (no external CDNs).
 * Store-only ZIP with CRC32; exports sheets/cells and numeric values faithfully.
 * Imported Combat Stats v4 exporter still determines sheet contents. */
const encoder=new TextEncoder();
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function colName(i){let t='';for(let n=i+1;n>0;n=Math.floor((n-1)/26))t=String.fromCharCode(65+(n-1)%26)+t;return t;}
function ref(r,c){return colName(c)+(r+1);}
function addr(s){let c=0;const chars=(s.match(/[A-Z]+/i)||['A'])[0].toUpperCase();for(const ch of chars)c=c*26+ch.charCodeAt(0)-64;return {r:Math.max(0,(Number((s.match(/\d+/)||[1])[0])-1)),c:c-1};}
const utils={
  book_new:()=>({SheetNames:[],Sheets:{}}),
  aoa_to_sheet:rows=>{const ws={__rows:rows};const end=ref(Math.max(0,rows.length-1),Math.max(0,Math.max(0,...rows.map(r=>r?.length??0))-1));ws['!ref']=`A1:${end}`;rows.forEach((row,r)=>row?.forEach((val,c)=>{ws[ref(r,c)]={v:val,t:typeof val==='number'?'n':'s'};}));return ws;},
  book_append_sheet:(wb,ws,name)=>{let s=String(name).replace(/[\\/\[\]*?:]/g,' ').slice(0,31)||'Sheet';let i=2;while(wb.SheetNames.includes(s))s=`${name.slice(0,26)} ${i++}`.slice(0,31);wb.SheetNames.push(s);wb.Sheets[s]=ws;},
  decode_range:value=>{const [a,b]=String(value).split(':');return {s:addr(a),e:addr(b||a)};},
  encode_cell:({r,c})=>ref(r,c)
};
function worksheetXML(ws){
  let text='';for(let r=0;r<(ws.__rows?.length||0);r++){
    const row=ws.__rows[r]||[];
    let cells='';for(let c=0;c<row.length;c++){
      let cell=ws[ref(r,c)],val=cell?.v;
      if(val===null||val===undefined||val==='')continue;
      const refstr=ref(r,c);
      if(typeof val==='number' && Number.isFinite(val))cells+=`<c r="${refstr}"><v>${val}</v></c>`;
      else cells+=`<c r="${refstr}" t="inlineStr"><is><t>${esc(val)}</t></is></c>`;
    }
    text+=`<row r="${r+1}">${cells}</row>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${text}</sheetData></worksheet>`;
}
const crcTable=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c>>>0;}return t;})();
function crc(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function zip(files){
  const parts=[],central=[];let offset=0;
  const put16=(v,b,o)=>{b[o]=v&255;b[o+1]=(v>>>8)&255;};
  const put32=(v,b,o)=>{put16(v,b,o);put16(v>>>16,b,o+2);};
  for(const [name,content] of files){
    const fname=encoder.encode(name),data=encoder.encode(content),checksum=crc(data);
    const local=new Uint8Array(30+fname.length);put32(0x04034b50,local,0);put16(20,local,4);put16(0,local,6);put16(0,local,8);put32(checksum,local,14);put32(data.length,local,18);put32(data.length,local,22);put16(fname.length,local,26);local.set(fname,30);
    parts.push(local,data);
    const dir=new Uint8Array(46+fname.length);put32(0x02014b50,dir,0);put16(20,dir,4);put16(20,dir,6);put32(checksum,dir,16);put32(data.length,dir,20);put32(data.length,dir,24);put16(fname.length,dir,28);put32(offset,dir,42);dir.set(fname,46);central.push(dir);
    offset+=local.length+data.length;
  }
  const centralSize=central.reduce((s,d)=>s+d.length,0);
  const end=new Uint8Array(22);put32(0x06054b50,end,0);put16(files.length,end,8);put16(files.length,end,10);put32(centralSize,end,12);put32(offset,end,16);
  const all=[...parts,...central,end];const result=new Uint8Array(all.reduce((a,b)=>a+b.length,0));let at=0;for(const b of all){result.set(b,at);at+=b.length;}return result;
}
function write(wb){
  const sheets=wb.SheetNames.map((name,i)=>[`xl/worksheets/sheet${i+1}.xml`,worksheetXML(wb.Sheets[name])]);
  const types=`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((e,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const wbXML=`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wb.SheetNames.map((s,i)=>`<sheet name="${esc(s)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`;
  const wbRels=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`;
  const rels=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip([['[Content_Types].xml',types],['_rels/.rels',rels],['xl/workbook.xml',wbXML],['xl/_rels/workbook.xml.rels',wbRels],...sheets]).buffer;
}
export const XLSXLite={utils,write};
export function saveFile(blob,filename){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),30000);}
