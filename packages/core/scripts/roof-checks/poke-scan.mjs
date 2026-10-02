// Walls standing up through a roof: every wall is trimmed as the preview does,
// and each point of its top that sits more than 6 cm above the TOP of the
// nearest roof surface below it is counted (a wall coming out of a lower
// roof, e.g. in front of a higher gable). Hidden spots inside another roof
// count too, so check the 3D view before chasing small ones.
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/poke-scan.mjs <draft.json>...
import fs from 'node:fs'
import * as THREE from 'three'
const { resolveRoofContext } = await import('../../dist/systems/roof/roof-scene.js')
const { roofMeshesForExport } = await import('../../dist/systems/roof/roof-export.js')
const { clipWallGeometry } = await import('../../dist/systems/roof/roof-wall-clip-system.js')
const L=console.log; console.log=()=>{}; console.warn=()=>{}
for (const f of process.argv.slice(2)) {
  let d; try { d=JSON.parse(fs.readFileSync(f,'utf8')) } catch { continue }
  if(!d.nodes) continue
  const ctx=resolveRoofContext(d.nodes)
  const tris=[]
  for (const [, m] of roofMeshesForExport(d.nodes, ctx)) {
    const V=i=>[m.vertices[3*i],m.vertices[3*i+1],m.vertices[3*i+2]]
    for(let k=0;k<m.faces.length;k+=3){const a=V(m.faces[k]),b=V(m.faces[k+1]),c=V(m.faces[k+2])
      const ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]); const nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]); const nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
      const Ln=Math.hypot(nx,ny,nz)||1; if(Math.abs(ny/Ln)<0.2) continue
      tris.push([a,b,c,Math.min(a[0],b[0],c[0]),Math.max(a[0],b[0],c[0]),Math.min(a[2],b[2],c[2]),Math.max(a[2],b[2],c[2]),ny>0])}
  }
  const surf=(x,z)=>{const ys=[];for(const [a,b,c,x0,x1,z0,z1,up] of tris){if(x<x0||x>x1||z<z0||z>z1)continue;const dd=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(dd)<1e-12)continue;const l1=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/dd,l2=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/dd,l3=1-l1-l2;if(l1<-1e-6||l2<-1e-6||l3<-1e-6)continue;ys.push([l1*a[1]+l2*b[1]+l3*c[1],up])}return ys}
  const out=[]
  for(const w of Object.values(d.nodes).filter(n=>n.type==='wall')){
    const len=Math.hypot(w.end[0]-w.start[0],w.end[1]-w.start[1]); if(len<1e-3) continue
    const t=w.thickness??0.15,h=w.height??2.7,dx=(w.end[0]-w.start[0])/len,dz=(w.end[1]-w.start[1])/len
    const g=new THREE.BoxGeometry(len,h,t,Math.ceil(len/0.05),1,1);g.translate(len/2,h/2,0)
    let o; try{o=clipWallGeometry(g,w,0,ctx)??g}catch{continue}
    const base=ctx.levels.get(w.parentId)?.elev??0
    const pos=o.getAttribute('position'); let n=0,mx=0,where=null
    for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i); if(y<0.3) continue
      const X=w.start[0]+dx*x-dz*z,Z=w.start[1]+dz*x+dx*z,Y=base+y
      const ys=surf(X,Z).filter(s=>s[0]<Y+0.001).sort((a,b)=>b[0]-a[0]); if(!ys.length) continue
      const [y0,up]=ys[0]; if(up&&Y-y0>0.06&&y0>base+0.05){n++; if(Y-y0>mx){mx=Y-y0;where=[X,Z]}}}
    if(n) out.push(`${w.id.slice(-6)} n=${n} out=${mx.toFixed(2)} at ${where.map(v=>v.toFixed(2))}`)
  }
  L(f.split(/[\/]/).pop(), out.length?'\n  '+out.join('\n  '):'clean')
}
