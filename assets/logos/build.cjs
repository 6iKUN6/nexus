const fs = require('fs');
const path = require('path');
const sharp = require('/Users/sparkle/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const out = __dirname;
const ink='#172924', mint='#70E3B0', paper='#F4F5EF';
function mark(a=ink,b=ink){return `<g fill="none" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"><path stroke="${a}" d="M64 192V64L112 112"/><path stroke="${b}" d="M144 144L192 192V64"/></g>`;}
function svg(w,h,body){return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;}
function text(x,y,str,size=20,color=ink,weight=400,extra=''){return `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" ${extra}>${str}</text>`;}
const files={
 'nexus-mark':svg(256,256,mark()),
 'nexus-mark-reverse':svg(256,256,mark(paper,paper)),
 'nexus-mark-color':svg(256,256,mark(ink,'#258764')),
 'nexus-lockup':svg(760,256,mark()+text(278,176,'Nexus',144,ink,600,'letter-spacing="-6"')),
 'nexus-app-icon':svg(512,512,`<rect x="8" y="8" width="496" height="496" rx="112" fill="${mint}"/><g transform="translate(64 64) scale(1.5)">${mark(ink,ink)}</g>`)
};
const board=svg(1600,1060,`
<rect width="1600" height="1060" fill="${paper}"/>
${text(76,66,'NEXUS / IDENTITY STUDY',15,ink,600,'letter-spacing="3"')}
${text(1300,66,'01 — RELAY',15,ink,400,'letter-spacing="2"')}
<path d="M76 94H1524" stroke="#CDD5CB"/>
<g transform="translate(245 152) scale(1.35)">${mark()}</g>
${text(620,385,'Nexus',178,ink,600,'letter-spacing="-8"')}
${text(627,440,'A workspace for connected agents.',24,'#607169')}
${text(76,550,'TWO AGENTS. ONE CONTINUOUS TASK.',14,'#607169',400,'letter-spacing="2"')}
<rect x="76" y="584" width="460" height="364" rx="24" fill="${ink}"/>
${text(102,622,'01 / APP ICON',13,'#B5C8BF',400,'letter-spacing="2"')}
<rect x="213" y="663" width="186" height="186" rx="43" fill="${mint}"/>
<g transform="translate(213 663) scale(.7265625)">${mark()}</g>
${text(233,906,'Nexus',20,paper,600)}
<rect x="558" y="584" width="460" height="364" rx="24" fill="#E6EBE1"/>
${text(584,622,'02 / SMALL &amp; SIMPLE',13,'#607169',400,'letter-spacing="2"')}
<g transform="translate(666 659) scale(.95)">${mark()}</g>
${text(668,906,'One color. Clear at every scale.',16,'#607169')}
<rect x="1040" y="584" width="484" height="364" rx="24" fill="#FFFFFF"/>
${text(1066,622,'03 / IN YOUR WORKSPACE',13,'#607169',400,'letter-spacing="2"')}
<rect x="1074" y="685" width="416" height="140" rx="15" fill="${paper}" stroke="#D8DED5"/>
<g transform="translate(1087 699) scale(.24)">${mark()}</g>
${text(1160,740,'Nexus',25,ink,600)}
<circle cx="1449" cy="731" r="5" fill="#258764"/>
<path d="M1074 760H1490" stroke="#D8DED5"/>
${text(1100,797,'Login fix',15,ink,600)}
${text(1238,797,'Code review',15,'#69786E')}
${text(1066,906,'Chat, collaborate, hand off.',16,'#607169')}
${text(76,1018,'Connection is the form. Handoff is the gap.',18,ink)}
<circle cx="1309" cy="1010" r="11" fill="${ink}"/><circle cx="1343" cy="1010" r="11" fill="${mint}"/><circle cx="1377" cy="1010" r="11" fill="#E6EBE1"/>
${text(1420,1017,'v0.1',16,'#607169')}
`);
files['nexus-brand-board']=board;
(async()=>{
 for(const [name,source] of Object.entries(files)){
  fs.writeFileSync(path.join(out,name+'.svg'),source);
  await sharp(Buffer.from(source)).png().toFile(path.join(out,name+'.png'));
 }
 for(const size of [16,24,32,64,128,256,512,1024]) await sharp(Buffer.from(files['nexus-app-icon'])).resize(size,size).png().toFile(path.join(out,`nexus-icon-${size}.png`));
 console.log('Created '+Object.keys(files).length+' SVG/PNG asset pairs and 8 app icon sizes.');
})();
