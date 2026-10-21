/** Minimal bundled canvas renderer for the Chart.js charts used by Combat Stats.
 * This is a local fallback to avoid a CDN dependency inside Foundry. */
function colour(x,i=0){return Array.isArray(x)?x[i%x.length]??'#8ad':x??'#8ad';}
export class ChartLite {
  constructor(ctx,config){this.ctx=ctx;this.config=config;this.draw();}
  destroy(){ /* no persistent listeners or timers */ }
  draw(){
    const c=this.ctx.canvas,w=Math.max(300,c.clientWidth||c.width||600),h=Math.max(250,c.clientHeight||c.height||350);
    const dpr=globalThis.devicePixelRatio||1;c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);
    this.ctx.setTransform(dpr,0,0,dpr,0,0);const x=this.ctx;x.clearRect(0,0,w,h);
    const {type,data,options}=this.config;
    const labels=data.labels||[], sets=data.datasets||[];
    if(!sets.length) return;
    const text='#dddddd', left=62,right=w-18,top=40,bottom=h-55;
    x.font='12px sans-serif';x.fillStyle=text;
    if(type==='doughnut'){
      const values=(sets[0].data||[]).map(v=>Math.max(0,Number(v)||0));let total=values.reduce((a,b)=>a+b,0)||1;
      const cx=w*0.42,cy=h*.53,r=Math.min(h*.35,w*.26),inner=r*.53;
      let a=-Math.PI/2;
      for(let i=0;i<values.length;i++){
        const e=a+values[i]/total*Math.PI*2;
        x.beginPath();x.arc(cx,cy,r,a,e);x.arc(cx,cy,inner,e,a,true);x.closePath();x.fillStyle=colour(sets[0].backgroundColor,i);x.fill();a=e;
      }
      labels.forEach((name,i)=>{
        x.fillStyle=colour(sets[0].backgroundColor,i);x.fillRect(w*.74,top+i*20,9,9);
        x.fillStyle=text;x.fillText(String(name).slice(0,18),w*.74+13,top+8+i*20);
      });return;
    }
    const all=sets.flatMap(s=>s.data||[]).map(v=>Math.max(0,Number(v)||0));
    const max=Math.max(1,...all), ymax=Math.ceil(max*1.1);
    x.strokeStyle='#5557';x.lineWidth=1;
    for(let i=0;i<=5;i++){
      const yy=top+(bottom-top)*(i/5);
      x.beginPath();x.moveTo(left,yy);x.lineTo(right,yy);x.stroke();
      x.fillStyle=text;x.fillText(String(Math.round(ymax*(1-i/5))),6,yy+3);
    }
    const bw=(right-left)/Math.max(1,labels.length), perSet=type==='bar'?bw/Math.max(1,sets.length):bw;
    for(let i=0;i<labels.length;i++){
      const xx=left+bw*i+bw/2;
      x.save();x.translate(xx,bottom+9);x.rotate(-.3);x.fillStyle=text;x.font='11px sans-serif';x.fillText(String(labels[i]).slice(0,16),-bw/3,0);x.restore();
    }
    if(type==='line'){
      sets.forEach((s,index)=>{
        x.strokeStyle=colour(s.borderColor,index);x.lineWidth=2;x.beginPath();
        (s.data||[]).forEach((v,i)=>{
          const xx=left+bw*(i+.5),yy=bottom-(bottom-top)*(Math.max(0,Number(v)||0)/ymax);
          i?x.lineTo(xx,yy):x.moveTo(xx,yy);
        });x.stroke();
        (s.data||[]).forEach((v,i)=>{const xx=left+bw*(i+.5),yy=bottom-(bottom-top)*(Math.max(0,Number(v)||0)/ymax);x.fillStyle=colour(s.pointBackgroundColor||s.borderColor,index);x.beginPath();x.arc(xx,yy,3,0,Math.PI*2);x.fill();});
        x.fillStyle=colour(s.borderColor,index);x.fillRect(16,12+index*16,11,7);x.fillStyle=text;x.fillText(String(s.label||'Series'),31,20+index*16);
      });
    }else{
      sets.forEach((s,j)=>(s.data||[]).forEach((v,i)=>{
        const hh=Math.max(0,Number(v)||0)/ymax*(bottom-top);
        const xx=left+i*bw+perSet*j+Math.min(4,perSet*.1);
        x.fillStyle=colour(s.backgroundColor,i);x.fillRect(xx,bottom-hh,Math.max(1,perSet-Math.min(8,perSet*.2)),hh);
      }));
    }
  }
}
