(function(){
'use strict';
var W=576,H=288,BG='#000',LV=[0,.36,.56,.78,1],F='20px "Helvetica Neue",Helvetica,Arial,sans-serif';
var SH=[],x=null,KO=false,T=0,RV=1,YL=0,i0;
for(i0=0;i0<16;i0++){var k0=i0/15;SH.push('rgb('+Math.round(60*k0)+','+Math.round(250*k0)+','+Math.round(68*k0)+')')}

function p(X,Y,a,w,h){x.fillStyle=KO?BG:SH[Math.round((a==null?1:a)*15)];x.fillRect(Math.round(X),Math.round(Y),w||1,h||1)}
function cl(X,Y,w,h){x.fillStyle=BG;x.fillRect(Math.round(X),Math.round(Y),w,h)}
function ln(x0,y0,x1,y1,a,d){x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
  if(Math.abs(x1-x0)+Math.abs(y1-y0)>5000)return;
  var dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1,e=dx+dy,i=0,e2;
  for(;;){if(!d||i%(d[0]+d[1])<d[0])p(x0,y0,a);i++;if(x0===x1&&y0===y1)break;e2=2*e;if(e2>=dy){e+=dy;x0+=sx}if(e2<=dx){e+=dx;y0+=sy}}}
function ci(cx,cy,r,a,fill){cx=Math.round(cx);cy=Math.round(cy);var X=r,Y=0,e=1-r;while(X>=Y){
  if(fill){p(cx-X,cy+Y,a,2*X+1,1);p(cx-X,cy-Y,a,2*X+1,1);p(cx-Y,cy+X,a,2*Y+1,1);p(cx-Y,cy-X,a,2*Y+1,1)}
  else{p(cx+X,cy+Y,a);p(cx+Y,cy+X,a);p(cx-X,cy+Y,a);p(cx-Y,cy+X,a);p(cx+X,cy-Y,a);p(cx+Y,cy-X,a);p(cx-X,cy-Y,a);p(cx-Y,cy-X,a)}
  Y++;if(e<0)e+=2*Y+1;else{X--;e+=2*(Y-X)+1}}}
function kod(cx,cy,r){KO=true;ci(cx,cy,r,1,true);KO=false}
function box(X,Y,w,h,a){p(X,Y,a,w,1);p(X,Y+h-1,a,w,1);p(X,Y,a,1,h);p(X+w-1,Y,a,1,h)}
function rr(X,Y,Wd,Ht,r,a){p(X+r,Y,a,Wd-2*r,1);p(X+r,Y+Ht-1,a,Wd-2*r,1);p(X,Y+r,a,1,Ht-2*r);p(X+Wd-1,Y+r,a,1,Ht-2*r);
  var u=r,v=0,e=1-r,q,i,A,B;while(u>=v){q=[[u,v],[v,u]];for(i=0;i<2;i++){A=q[i][0];B=q[i][1];p(X+r-A,Y+r-B,a);p(X+Wd-1-r+A,Y+r-B,a);p(X+r-A,Y+Ht-1-r+B,a);p(X+Wd-1-r+A,Y+Ht-1-r+B,a)}
  v++;if(e<0)e+=2*v+1;else{u--;e+=2*(v-u)+1}}}
function tx(s,X,Y,l,al){x.fillStyle=SH[Math.round(LV[l==null?4:l]*15)];x.font=F;x.textAlign=al||'left';x.textBaseline='top';x.fillText(s,Math.round(X),Y+4)}
function tw(s){x.font=F;return x.measureText(s).width}

var FONT={'0':'ehjlphe','1':'4c4444e','2':'eh1248v','3':'v2421he','4':'26aiv22','5':'vgu11he','6':'68guhhe','7':'v124888','8':'ehhehhe','9':'ehhf12c',
A:'ehhvhhh',B:'uhhuhhu',C:'ehggghe',D:'sihhhis',E:'vgguggv',F:'vgguggg',G:'ehgnhhf',H:'hhhvhhh',I:'e44444e',J:'72222ic',K:'hikokih',L:'ggggggv',M:'hrllhhh',
N:'hhpljhh',O:'ehhhhhe',P:'uhhuggg',Q:'ehhhlid',R:'uhhukih',S:'fgge11u',T:'v444444',U:'hhhhhhe',V:'hhhhha4',W:'hhhllla',X:'hha4ahh',Y:'hhha444',Z:'v1248gv',
':':'0cc0cc0','.':'00000cc',',':'0000c48','/':'01248g0','+':'044v440','-':'000v000','·':'000cc00','°':'ciic000','!':'4444404','>':'8421248'};
function pf(s,X,Y,sc,a,dots){s=String(s).toUpperCase();var cx=Math.round(X),i,r,c,g,v,d=dots?sc-1:sc;Y=Math.round(Y);
  for(i=0;i<s.length;i++){g=FONT[s.charAt(i)];if(g)for(r=0;r<7;r++){v=parseInt(g.charAt(r),32);for(c=0;c<5;c++)if(v&(16>>c))p(cx+c*sc,Y+r*sc,a,d,d)}cx+=6*sc}}
function pw(s,sc){return String(s).length*6*sc-sc}
function pfr(s,XR,Y,sc,a,dots){pf(s,XR-pw(s,sc),Y,sc,a,dots)}
function pfc(s,XC,Y,sc,a,dots){pf(s,XC-pw(s,sc)/2,Y,sc,a,dots)}

var IC={
answers:['....####....','..##....##..','.#........#.','.#...##...#.','#...####...#','#..######..#','#..######..#','#...####...#','.#...##...#.','.#........#.','..##....##..','....####....'],
code:['............','##..........','.##.........','..##...####.','...##..####.','....##.####.','....##.####.','...##..####.','..##...####.','.##.........','##..........','............'],
hackos:['##........##','##........##','##........##','##........##','##........##','##.##..##.##','##.##..##.##','##........##','##........##','##........##','##........##','##........##'],
around:['.....##.....','.....##.....','...######...','..##....##..','..#......#..','###..##..###','###..##..###','..#......#..','..##....##..','...######...','.....##.....','.....##.....'],
sky:['.....##.....','.....##.....','.....##.....','....####....','..########..','############','###..##..###','.....##.....','.....##.....','....####....','..########..','.....##.....']};
var NAME={answers:'Answers',code:'Code',hackos:'HackOS',around:'Around',sky:'Sky'};
var OPEN={answers:[3000,'listening'],code:[2400,'working'],hackos:[2000,'answer'],around:[2600,'live'],sky:[3000,'live']};

function icon(g,X,Y,s,gap){for(var r=0;r<12;r++)for(var c=0;c<12;c++){var v=g[r][c];if(v!=='.')p(X+c*s,Y+r*s,v==='#'?1:.4,s-(gap||0),s-(gap||0))}}
function frame(app,scr){var g=IC[app].map(function(r){return r.split('')}),r,c,k,col,f;
  if(app==='answers'&&scr==='listening'&&Math.floor(T/.8)%2)for(r=3;r<9;r++)for(c=3;c<9;c++)if(g[r][c]==='#'&&!(r>4&&r<7&&c>4&&c<7))g[r][c]='+';
  if(app==='code'&&scr==='working'){k=Math.floor(T*6)%6;col=7+(k<4?k:6-k);for(r=3;r<9;r++)for(c=7;c<11;c++)g[r][c]=c===col?'#':'+'}
  if(app==='code'&&scr==='allow'){for(r=4;r<8;r++)for(c=8;c<10;c++)g[r][c]='.';if(Math.floor(T*2)%2)for(r=3;r<9;r++)for(c=7;c<11;c++)if(g[r][c]==='#')g[r][c]='+'}
  if(app==='hackos'&&scr==='waking'){f=Math.floor(T*2)%9;for(c=2;c<10;c++){g[5][c]=c-2<f?'#':'+';g[6][c]=g[5][c]}}
  return g}
function okey(a,r,c){var d=Math.hypot(r-5.5,c-5.5)/7.8,g;
  if(a==='answers'){if(r>2&&r<9&&c>2&&c<9)return .76+d*.3;g=Math.atan2(c-5.5,5.5-r);if(g<0)g+=Math.PI*2;return g/(Math.PI*2)*.7}
  if(a==='code')return c<6?r/11*.5:.55+((c-7)*6+(r-3))/24*.4;
  if(a==='hackos')return (r===5||r===6)&&c>1&&c<10?.6+(c-2)/8*.35:(11-r)/11*.55;
  if(a==='around')return d*.95;
  return (11-r)/11*.9}
function splash(app,ms){var e=Math.min(1,ms/900),dr=1-Math.pow(1-e,3),q=ms>1300?(ms-1300)/300:0,X=240,Y=70,r,c,ky,hot,nm,n;
  for(r=0;r<12;r++)for(c=0;c<12;c++){if(IC[app][r].charAt(c)==='.')continue;ky=okey(app,r,c);if(ky>dr)continue;if(q&&((r*7+c*13)%17)/17<q)continue;
    hot=(dr-ky<.07&&e<1)||(ms>=900&&ms<1250);p(X+c*8,Y+r*8,hot?1:.72,6,6)}
  nm=NAME[app];n=Math.max(0,Math.min(nm.length,Math.ceil((ms-500)/500*nm.length)));
  if(n)tx(nm.slice(0,n),Math.round((W-tw(nm))/2),184,q>.66?1:q>.33?2:q?3:4)}

function hdr(app,scr,label,ox){ox=ox||0;icon(frame(app,scr),ox,2,2);tx(label,ox+32,0,3);pfr('18:16',W,7,2,.8);p(ox,30,.3,W-ox,1)}
function meter(X){for(var i=0;i<5;i++){var h=3+Math.round(10*Math.abs(Math.sin(T*3.1+i*1.7)*Math.sin(T*.9+i)));p(X+i*5,22-h,.85,3,h)}}
function pages(X,n,cur){for(var i=0;i<n;i++){if(i===cur)p(X+i*10,10,1,6,6);else box(X+i*10,10,6,6,.55)}}
function tabs(X){p(X,9,1,8,8);box(X+12,9,8,8,.55);box(X+24,9,8,8,.55)}

function rot(v,yaw,pit){var c=Math.cos(yaw),s=Math.sin(yaw),x1=v[0]*c+v[2]*s,z1=-v[0]*s+v[2]*c;c=Math.cos(pit);s=Math.sin(pit);return[x1,v[1]*c-z1*s,v[1]*s+z1*c]}
function pr(v,cx,cy,sc){var k=3.4/(3.4+v[2]);return[cx+v[0]*sc*k,cy-v[1]*sc*k,v[2]]}
function rng(s){return function(){s|=0;s=s+0x6D2B79F5|0;var t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function label(s,X,Y,a){var w=pw(s,1);cl(X-2,Y-2,w+4,11);pf(s,X,Y,1,a)}

var VG=(function(){var r=rng(7),N=[[.08,.04,-.12],[.5,.34,-.3],[-.2,.55,.15],[.3,-.45,-.38]],E=[[0,1],[0,2],[0,3]],C=[[.62,.2,.32],[-.62,.3,-.2],[0,-.62,.46],[-.22,.1,-.72],[.3,.72,-.1]],i,j,c,best,bd,d;
  for(i=4;i<40;i++){c=C[i%5];N.push([c[0]+(r()-.5)*.72,c[1]+(r()-.5)*.72,c[2]+(r()-.5)*.72])}
  for(i=4;i<N.length;i++){best=0;bd=9;for(j=0;j<i;j++){d=Math.hypot(N[i][0]-N[j][0],N[i][1]-N[j][1],N[i][2]-N[j][2]);if(d<bd){bd=d;best=j}}E.push([i,best]);if(r()<.4)E.push([i,Math.floor(r()*i)])}
  return{N:N,E:E}})();
function graph(g,cx,cy,sc,yaw,pit,o){o=o||{};var P=g.N.map(function(n){return pr(rot(n,yaw,pit),cx,cy,sc)}),lit=o.lit||[0,1,2,3];
  function on(i){return lit.indexOf(i)>=0}
  var vis=o.vis?o.vis(P):null;g.E.forEach(function(e){if(vis&&(!vis[e[0]]||!vis[e[1]]))return;var a=P[e[0]],b=P[e[1]],z=(a[2]+b[2])/2;
    if(on(e[0])&&on(e[1]))ln(a[0],a[1],b[0],b[1],1);else ln(a[0],a[1],b[0],b[1],z<-.2?.45:z<.35?.3:.22,z<.35?null:[1,2])});
  P.forEach(function(q,i){if(vis&&!vis[i])return;var z=q[2];
    if(on(i)){if(i===0&&!o.mini){kod(q[0],q[1],9);p(q[0]-2,q[1]-2,1,5,5);ci(q[0],q[1],8,1);p(q[0]-12,q[1],1,3,1);p(q[0]+10,q[1],1,3,1);p(q[0],q[1]-12,1,1,3);p(q[0],q[1]+10,1,1,3)}
      else{cl(q[0]-3,q[1]-3,7,7);p(q[0]-2,q[1]-2,1,5,5)}}
    else if(z<-.3)p(q[0]-1,q[1]-1,.8,3,3);else if(z<.4)p(q[0]-1,q[1]-1,.55,2,2);else p(q[0],q[1],.45)});
  if(o.labels)o.labels.forEach(function(s,i){if(s)label(s,P[i][0]+8,P[i][1]-3,.85)});
  return P[0]}

function vaultOpen(){var q=Math.min(1,Math.max(0,(RV-.08)/.6)),d=RV>.82?(RV-.82)/.18:0,n=VG.N.length,c=String(Math.round(214*q));
  graph(VG,150,108,60,T*.5,.36,{lit:[],vis:function(P){var idx=P.map(function(_,i){return i}).sort(function(a,b){return P[b][2]-P[a][2]}),v=[],k;for(k=0;k<n;k++)v[idx[k]]=k<q*n&&!(d&&((idx[k]*7)%13)/13<d);return v}});
  if(d<.6){pf('VAULT ONLINE',330,88,1,.5);pfr(Math.round(11*q)+' PEOPLE',560,88,1,.5);pf(c,330,100,6,1,true);pf('NOTES',338+pw(c,6),135,1,.6)}}
var WK=(function(){var r=rng(21),N=[[0,0,0]],E=[],d,f,a,dp,di,u,v;
  for(d=0;d<4;d++){a=d*Math.PI/2+.4;dp=[Math.cos(a)*.8,[.38,-.42,.46,-.3][d],Math.sin(a)*.8];N.push(dp);di=N.length-1;E.push([0,di]);
    for(f=0;f<5;f++){u=r()*6.283;v=(r()-.5)*1.6;N.push([dp[0]+Math.cos(u)*.42*Math.cos(v),dp[1]+Math.sin(v)*.42,dp[2]+Math.sin(u)*.42*Math.cos(v)]);E.push([di,N.length-1])}}
  return{N:N,E:E}})();
function wgraph(cx,cy,sc,yaw,rv){rv=rv==null?1:rv;function fr(i){var d=i===1||i===7||i===13||i===19;return i===0?1:Math.max(0,Math.min(1,d?(rv-.08)/.34:(rv-.42)/.36))}function lab(s,q,dy,a,ex){var o=9+(ex||0);label(s,q[0]>cx+20?q[0]-o-pw(s,1):q[0]+o,q[1]+dy,a)}var P=WK.N.map(function(n){return pr(rot(n,yaw,.36),cx,cy,sc)}),hot={'0-1':1,'1-2':1,'1-3':1,'0-13':1,'13-14':1},q,rp;
  WK.E.forEach(function(e){var a=P[e[0]],b=P[e[1]],z=(a[2]+b[2])/2,f=fr(e[1]);if(!f)return;b=[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];if(rv>=.86&&hot[e[0]+'-'+e[1]])ln(a[0],a[1],b[0],b[1],1);else ln(a[0],a[1],b[0],b[1],z<0?.35:.25,[1,2])});
  P.forEach(function(q,i){if(fr(i)<1)return;if(i===0||(rv>=.86&&(i===2||i===3||i===14)))return;if(i===1||i===7||i===13||i===19)p(q[0]-1,q[1]-1,i===1||i===13?1:.6,3,3);else p(q[0]-1,q[1]-1,q[2]<0?.6:.4,2,2)});
  q=P[0];kod(q[0],q[1],7);ci(q[0],q[1],6,1);p(q[0]-1,q[1]-1,1,3,3);label('G2-HUD',q[0]-17,q[1]+11,.6);
  if(rv<.86){label('MAPPING PROJECT',cx-44,cy+70,.6);return}q=P[2];cl(q[0]-4,q[1]-4,9,9);p(q[0]-3,q[1]-3,1,7,7);lab('SETTINGS/PAGE.TSX',q,-13,.9);
  q=P[3];cl(q[0]-4,q[1]-4,9,9);box(q[0]-3,q[1]-3,7,7,1);lab('THEME.TS',q,6,.7);
  q=P[14];rp=7+Math.floor(T*4)%4;kod(q[0],q[1],10);p(q[0]-2,q[1]-2,1,5,5);ci(q[0],q[1],rp,rp>8?.5:1);lab('PAGE.TEST.TS',q,-3,1,5)}

var IV=[],IE=[];(function(){var ph=(1+Math.sqrt(5))/2,R=[[-1,ph,0],[1,ph,0],[-1,-ph,0],[1,-ph,0],[0,-1,ph],[0,1,ph],[0,-1,-ph],[0,1,-ph],[ph,0,-1],[ph,0,1],[-ph,0,-1],[-ph,0,1]],L=Math.hypot(1,ph),a,b;
  IV=R.map(function(v){return[v[0]/L,v[1]/L,v[2]/L]});
  for(a=0;a<12;a++)for(b=a+1;b<12;b++)if(Math.abs(Math.hypot(R[a][0]-R[b][0],R[a][1]-R[b][1],R[a][2]-R[b][2])-2)<1e-6)IE.push([a,b])})();
function core(cx,cy,R,pg,quiet){var yaw=T*(quiet?.35:.6),pit=.42+.12*Math.sin(T*.5),P=IV.map(function(v){return pr(rot(v,yaw,pit),cx,cy,R)}),n=Math.round(pg*30),k,g,v,q,s;
  IE.forEach(function(e,i){var a=P[e[0]],b=P[e[1]],z=(a[2]+b[2])/2;if(i<n)ln(a[0],a[1],b[0],b[1],quiet?(z<0?.7:.35):(z<0?1:.5));else ln(a[0],a[1],b[0],b[1],.4,[1,2])});
  P.forEach(function(q){if(q[2]<0)p(q[0]-1,q[1]-1,quiet?.7:1,3,3)});
  if(!quiet){for(k=0;k<90;k++){g=k/90*6.283;v=rot([Math.cos(g)*1.5,0,Math.sin(g)*1.5],T*.9,1.15);q=pr(v,cx,cy,R);p(q[0],q[1],v[2]<0?.75:.4)}
    s=pr(rot([Math.cos(T*2)*1.5,0,Math.sin(T*2)*1.5],T*.9,1.15),cx,cy,R);p(s[0]-1,s[1]-1,1,3,3)}}

function boot(cx,cy,R){var P=IV.map(function(v){return pr(rot(v,T*.6,.42),cx,cy,R)}),nv=Math.round(12*Math.min(1,RV/.3)),ne=Math.round(30*Math.max(0,Math.min(1,(RV-.3)/.55))),i;
  IE.forEach(function(e,i){if(i>=ne)return;var a=P[e[0]],b=P[e[1]],z=(a[2]+b[2])/2;ln(a[0],a[1],b[0],b[1],z<0?1:.5)});
  for(i=0;i<nv;i++)p(P[i][0]-1,P[i][1]-1,1,3,3);
  pfc(RV<.3?'CORE':RV<.85?'LINKING':'CORE ONLINE',cx,cy+R+14,1,.6)}
function plane(X,Y,deg,a){var r=(deg-90)*Math.PI/180,tp=[X+Math.cos(r)*6,Y+Math.sin(r)*6],l=[X+Math.cos(r+2.5)*5,Y+Math.sin(r+2.5)*5],q=[X+Math.cos(r-2.5)*5,Y+Math.sin(r-2.5)*5];
  ln(tp[0],tp[1],l[0],l[1],a);ln(tp[0],tp[1],q[0],q[1],a);ln(l[0],l[1],X,Y,a);ln(q[0],q[1],X,Y,a)}
function arr(cx,cy,deg,a){var r=(deg-90)*Math.PI/180,dx=Math.cos(r),dy=Math.sin(r),hx=cx+dx*5,hy=cy+dy*5;
  ln(cx-dx*5,cy-dy*5,hx,hy,a);ln(hx,hy,hx+Math.cos(r+2.6)*4,hy+Math.sin(r+2.6)*4,a);ln(hx,hy,hx+Math.cos(r-2.6)*4,hy+Math.sin(r-2.6)*4,a)}

function gp(X,Y,h){var D=Y+220,s=200/D;return[288+X*s,44+33440/D-(h||0)*s,D]}
function gl(X0,Y0,X1,Y1,a,d){var A=gp(X0,Y0),B=gp(X1,Y1);ln(A[0],A[1],B[0],B[1],a,d)}
function poly(pts,fn){var ys=pts.map(function(q){return q[1]}),y0=Math.max(31,Math.ceil(Math.min.apply(null,ys))),y1=Math.min(225,Math.floor(Math.max.apply(null,ys))),y,i,k,a,b,xs,X;
  for(y=y0;y<=y1;y++){xs=[];for(i=0;i<pts.length;i++){a=pts[i];b=pts[(i+1)%pts.length];if((a[1]<=y&&b[1]>y)||(b[1]<=y&&a[1]>y))xs.push(a[0]+(y-a[1])/(b[1]-a[1])*(b[0]-a[0]))}
    xs.sort(function(m,n){return m-n});for(k=0;k+1<xs.length;k+=2)for(X=Math.max(0,Math.ceil(xs[k]));X<=Math.min(575,Math.floor(xs[k+1]));X++)fn(X,y)}}
function beacon(X,Y,h,sev,text){var g=gp(X,Y),rs=1,t,i,R,a,q;if(RV<1){if(g[1]<YL)return;rs=Math.min(1,(g[1]-YL)/26)}t=gp(X,Y,h*rs);if(rs<1)text=null;
  if(sev===3){R=30+((T*22)%44);for(i=0;i<72;i+=2){a=i/72*6.283;q=gp(X+Math.sin(a)*R,Y+Math.cos(a)*R);p(q[0],q[1],.75)}}
  ln(g[0],g[1],t[0],t[1],sev>1?1:.6);p(g[0]-2,g[1],.8,5,1);kod(t[0],t[1]-6,8);
  if(sev===3){for(i=0;i<6;i++){p(t[0]-i,t[1]-11+i,1,2*i+1,1);p(t[0]-i,t[1]-1-i,1,2*i+1,1)}KO=true;p(t[0],t[1]-9,1,1,4);p(t[0],t[1]-4,1,1,1);KO=false}
  else if(sev===2){for(i=0;i<6;i++){p(t[0]-i,t[1]-11+i);p(t[0]+i,t[1]-11+i);p(t[0]-i,t[1]-1-i);p(t[0]+i,t[1]-1-i)}p(t[0]-1,t[1]-7,1,3,3)}
  else ci(t[0],t[1]-4,3,.8);
  if(text)label(text,t[0]+11,t[1]-9,sev===3?1:.7)}
function arow(y,sev,title,dist,deg,l){
  if(sev===3){p(0,y+8,1,11,11);KO=true;p(5,y+10,1,1,5);p(5,y+16,1,1,1);KO=false}else{ci(5,y+13,5,.8);p(4,y+12,.8,3,3)}
  tx(title,22,y,l);arr(566,y+13,deg,l===4?1:.7);pfr(dist,550,y+7,2,l===4?1:.7)}

var PL=[[.8,300,60,'XQT472',1800,150],[5,50,200,'QXA1352',4500,210],[7.3,215,330,'ZKV608',12000,300],[17.5,320,110,'JWQ1173',31000,450]];
var Q1='“So what are you working on these days?”',Q3='“Give me three names for a sailing club”';
var SC={
answers:{
listening:function(){hdr('answers','listening','Listening');meter(484);
  var k,j,env,v,n,hw=RV<1?Math.round(36*Math.min(1,RV/.25)):36;if(RV<1)vaultOpen();for(k=-hw;k<=hw;k++){env=Math.cos(k/36*Math.PI/2);v=Math.abs(Math.sin(k*.45+T*5)*Math.sin(k*.13-T*2.2))*env*env;n=Math.round(v*5);for(j=-n;j<=n;j++)p(288+k*4,176+j*4,j===0?.9:.9-Math.abs(j)*.13,2,2)}
  tx('Tap pause  ·  Double tap clear  ·  Hold save',0,255,1)},
recall:function(){hdr('answers','recall','Recall');meter(484);
  var f=graph(VG,142,168,92,T*.22,.36+.08*Math.sin(T*.3),{labels:[null,'PRICING PLAN','NORTHWIND','ATLAS MIGRATION']});
  ln(f[0],f[1]-13,f[0],46,.6,[1,2]);ln(f[0],46,298,46,.6,[1,2]);
  ln(294,52,294,286,.3,[1,3]);
  pf('PERSON',304,42,1,.5);pfr('SEEN 12 NOV',W,42,1,.5);
  pf('SARAH CHEN',304,56,3,1,true);
  tx('Head of procurement',304,82,3);tx('Northwind  ·  met 4 times',304,109,2);
  pf('LAST MEETING',304,146,1,.5);tx('12 Nov  ·  Pricing plan',304,154,3);
  pf('OPEN',304,190,1,.5);tx('Send the deck',304,198,3);
  pf('VAULT  214 NOTES  ·  11 PEOPLE',304,276,1,.4)},
answer:function(){hdr('answers','answer','Answer');meter(484);tx(Q1,0,36,2);
  ['• Mostly the route planner app at','   Acme Freight.','• This week: faster stock lookups','   from depot records.','• Happy to show you a demo later.'].forEach(function(s,i){tx(s,0,72+i*27,4)});
  graph(VG,510,112,40,T*.3,.4,{mini:true,lit:[0,1,3]});
  pfc('FROM 3 NOTES',510,170,1,.6);['SARAH CHEN','PRICING PLAN','ATLAS MIGRATION'].forEach(function(s,i){pfc(s,510,184+i*10,1,.4)})}},
code:{
working:function(){hdr('code','working','Working');tabs(462);
  tx('“Add a dark mode toggle to the',0,36,2);tx('settings page”',0,63,2);
  ln(5,112,5,166,.4,[1,2]);
  [['Read src/settings/page.tsx',2],['Edit src/settings/page.tsx',2],['$ npm test',4]].forEach(function(r,i){if(RV<1&&RV<.3+i*.22)return;var y=100+i*27;
    if(i<2){cl(2,y+10,7,7);p(3,y+11,.6,5,5)}else{cl(1,y+9,9,9);box(2,y+10,7,7,1);p(4,y+12,Math.floor(T*3)%2?1:.3,3,3)}tx(r[0],18,y,r[1])});
  var sec=12+Math.floor(T)%40,i;pf('ELAPSED',0,206,1,.5);pf('0:'+('0'+sec).slice(-2),0,218,4,1,true);
  pf('3 STEPS',110,220,1,.6);pf('3 FILES',110,231,1,.6);pf('+42 -7',110,242,1,.6);for(i=0;i<7;i++)p(152+i*6,242,i<6?.9:.3,4,7);
  ln(294,36,294,286,.3,[1,3]);wgraph(430,160,84,T*.25,RV)},
allow:function(){hdr('code','allow','Allow?');tabs(462);tx('“Install the font measurement library”',0,36,2);
  rr(0,76,576,96,6,1);p(16,70,1,35,13);KO=true;pf('BASH',21,73,1);KO=false;pfr('NEEDS NETWORK',556,88,1,.5);
  tx('$ npm install @evenrealities/pretext',20,96,4);tx('in ~/Desktop/g2-hud',20,123,2);
  var rem=108-Math.floor(T)%100,w=Math.round(496*rem/120),i;p(0,186,1,w,2);for(i=w+2;i<496;i+=4)p(i,186,.4,1,2);
  pfr(Math.floor(rem/60)+':'+('0'+rem%60).slice(-2),W,180,2,.9);
  tx('Tap allow  ·  Double tap deny',0,255,1)}},
hackos:{
waking:function(){hdr('hackos','waking','Waking the GPU');tx(Q3,0,36,2);
  var sec=4+Math.floor(T)%50,pg=sec/60,i,n=Math.round(pg*30);core(100,178,76,pg);
  pf('GPU COLD START',222,92,1,.5);pf(('0'+sec).slice(-2),222,106,6,1,true);pf('SEC',296,141,1,.6);
  for(i=0;i<30;i++)p(222+i*8,162,i<n?1:.25,5,5);
  tx('The first answer takes about a minute.',222,176,2);pf('QWEN3.8-27B',222,276,1,.4)},
answer:function(){hdr('hackos','answer','HackOS');var i,h;if(RV<1){boot(506,170,58);tx('Hold talk  ·  Double tap new chat',0,255,1);return}
  for(i=0;i<22;i++){h=2+Math.round(9*Math.abs(Math.sin(i*.7+1)*Math.cos(i*.31)));p(378+i*3,21-h,.7,2,h)}
  pfr('38 TOK/S',502,10,1,.6);tx(Q3,0,36,2);
  ['• Windward Club','• The Slack Tide Society','• Harbour Reach Sailing'].forEach(function(s,i){tx(s,0,72+i*27,4)});
  core(506,170,58,1,true);pf('2.1 S  ·  96 TOKENS  ·  QWEN3.8-27B',0,276,1,.4)}},
around:{
live:function(){var i,X,Y,q,g,me,a,wq,l,w;
  [-60,90,240,510,660,810,1000,1250,1500].forEach(function(Y){gl(-1500,Y,1500,Y,Y<200?.5:Y<700?.4:.3,[1,2])});
  for(X=-1050;X<=1050;X+=150)gl(X,-60,X,1500,.3,[1,2]);
  wq=[gp(260,40),gp(1700,40),gp(1700,330),gp(260,330)];KO=true;poly(wq,function(a,b){p(a,b)});KO=false;poly(wq,function(a,b){if((a+b)%5===0)p(a,b,.45)});
  for(X=-700;X<=-460;X+=20)for(Y=420;Y<=640;Y+=20){q=gp(X,Y);p(q[0],q[1],.55)}
  a=[[-80,-60],[-40,300],[60,700],[200,1500]];for(i=1;i<a.length;i++){gl(a[i-1][0],a[i-1][1],a[i][0],a[i][1],1);gl(a[i-1][0]+4,a[i-1][1],a[i][0]+4,a[i][1],1)}
  gl(-900,358,1700,340,.6);
  [250,500].forEach(function(R){for(i=0;i<240;i+=2){g=i/240*6.283;Y=Math.cos(g)*R;if(Y+220<70)continue;q=gp(Math.sin(g)*R,Y);p(q[0],q[1],.65)}});
  l=gp(143,205);label('250',l[0]+4,l[1]-3,.6);l=gp(250,433);label('500M',l[0]+4,l[1]-3,.6);
  if(RV<1){YL=Math.round(226-182*RV);cl(0,44,W,YL-44);for(X=0;X<W;X+=2)p(X,YL,1);for(X=1;X<W;X+=4)p(X,YL+3,.5);for(X=3;X<W;X+=8)p(X,YL+7,.3);
    q=33440/Math.max(1,YL-44)-220;if(YL>58){label(q<1000?Math.max(0,Math.round(q/10)*10)+'M':(q/1000).toFixed(1)+'KM',W-34,YL-10,1);label('MAPPING',4,YL-10,.7)}}
  [[-420,120,90,70,60],[-300,260,80,80,110],[-560,330,120,90,45],[-190,440,70,60,150],[-640,150,100,80,80],[130,500,90,70,90],[330,420,110,70,60],[-60,900,120,90,120],[420,760,140,100,80]].forEach(function(b){var c=[],k,g0=gp(b[0],b[1]),rs=1;
    if(RV<1){if(g0[1]<YL)return;rs=Math.min(1,(g0[1]-YL)/26)}
    for(k=0;k<8;k++)c.push(gp(b[0]+(k&1?b[2]:0),b[1]+(k&2?b[3]:0),k&4?b[4]*rs:0));
    [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]].forEach(function(e){ln(c[e[0]][0],c[e[0]][1],c[e[1]][0],c[e[1]][1],b[1]<300?.6:.42)})});
  beacon(-90,640,30,1);beacon(-250,180,46,2,'ROADWORKS');beacon(140,420,70,3,'COLLISION');
  g=gp(-520,900);if(RV>=1||g[1]>=YL){q=gp(-520,900,110);ln(g[0],g[1],q[0],q[1],.4,[1,2]);p(g[0]-2,g[1],.5,5,1);kod(q[0],q[1],7);plane(q[0],q[1],60,1);label('XQT472 1.8K',q[0]+10,q[1]-3,.8)}
  me=gp(0,0);if(RV>=1||me[1]>=YL){kod(me[0],me[1],12);for(i=0;i<11;i++)p(me[0]-Math.floor(i*.6),me[1]-7+i,1,1+2*Math.floor(i*.6),1);KO=true;p(me[0]-1,me[1]+2,1,3,2);KO=false}
  cl(0,0,W,43);hdr('around','live','Harbour Quarter');w=tw('Harbour Quarter');pf('3 ALERTS  ·  4 AIRCRAFT',46+w,11,1,.5);
  [['NW',216],['N',288],['NE',360]].forEach(function(h){pfc(h[0],h[1],33,1,h[0]==='N'?1:.5)});
  for(X=180;X<=396;X+=12)if(Math.abs(X-216)>8&&Math.abs(X-288)>8&&Math.abs(X-360)>8)p(X,35,.4,1,3);
  for(X=0;X<W;X+=3)p(X,44,.28);
  cl(0,226,W,62);p(0,226,.3,W,1);arow(232,3,'Collision, two lanes closed','440M',18,4);arow(259,2,'Road closed for works','310M',306,3)}},
sky:{
live:function(){var cx=144,cy=196,TL=.42,i,k,s,e,w;
  function dp(km,deg){var r=134*Math.sqrt(Math.min(km,60)/60),a=(deg-90)*Math.PI/180;return[cx+Math.cos(a)*r,cy+Math.sin(a)*r*TL]}
  function ell(r,a,step){var n=Math.round(r*5),k,g;for(k=0;k<n;k++){if(step&&k%step)continue;g=k/n*6.283;p(cx+Math.cos(g)*r,cy+Math.sin(g)*r*TL,a)}}
  var ra=RV<1?Math.min(1,RV/.3):1,rb=RV<1?Math.max(0,Math.min(1,(RV-.3)/.14)):1,rc=RV<1?Math.max(0,Math.min(1,(RV-.44)/.56)):1,nf=0,acq=RV<1&&rc*360<300;[2,10,30].forEach(function(km){var r0=134*Math.sqrt(km/60);if(r0<=134*ra)ell(r0,.45,2)});if(ra>=1)ell(134,.9,0);else{ell(134*ra,1,2);label(Math.round(60*ra*ra)+' KM',cx-12,cy+134*ra*TL+6,.8)}
  if(ra>=1)for(i=0;i<360;i+=30){var a=(i-90)*Math.PI/180;ln(cx+Math.cos(a)*125,cy+Math.sin(a)*125*TL,cx+Math.cos(a)*134,cy+Math.sin(a)*134*TL,i%90?.5:1)}
  if(ra>=1){pfc('N',cx,cy-134*TL-11,1,1);pf('E',cx+136,cy-3,1,.5);pfc('S',cx,cy+134*TL+5,1,.5);pf('W',cx-141,cy-3,1,.5)}
  s=RV<1?rc*360:(T*40)%360;if(RV>=1||rc>0)for(k=9;k>=0;k--){e=dp(60,s-k*4);ln(cx,cy,e[0],e[1],k?.4:1,k?[1,k+1]:null)}
  if(rb>0)ln(cx,cy,cx,cy-134*rb,.35,[1,3]);for(k=1;k<=4;k++){if(rb<k/4)continue;p(cx-2,cy-k*32,.5,5,1);p(0,cy-k*32,.6,5,1);pf(k*10+'K',8,cy-k*32-3,1,.5)}
  PL.slice(1).sort(function(m,n){return dp(m[0],m[1])[1]-dp(n[0],n[1])[1]}).concat([PL[0]]).forEach(function(pl){var rs=1;if(RV<1){if(rc*360<pl[1])return;rs=Math.min(1,(rc*360-pl[1])/45);nf++}var g=dp(pl[0],pl[1]),h=pl[4]/1000*3.2*rs,m=[Math.round(g[0]),Math.round(g[1]-h)],sel=pl===PL[0],fl=pl[4]>=10000?'FL'+Math.round(pl[4]/100):(pl[4]/1000).toFixed(1)+'K',lw=pw(pl[3],1),lx;
    ln(g[0],g[1],m[0],m[1],.5,[1,2]);p(g[0]-2,g[1],.6,5,1);p(g[0],g[1]-1,.6,1,3);kod(m[0],m[1],8);plane(m[0],m[1],pl[2],sel?1:.8);
    if(sel){p(m[0]-10,m[1]-10,1,4,1);p(m[0]-10,m[1]-10,1,1,4);p(m[0]+7,m[1]-10,1,4,1);p(m[0]+10,m[1]-10,1,1,4);p(m[0]-10,m[1]+10,1,4,1);p(m[0]-10,m[1]+7,1,1,4);p(m[0]+7,m[1]+10,1,4,1);p(m[0]+10,m[1]+7,1,1,4)}
    if(!sel&&rs>=1){lx=m[0]<cx?m[0]-14-lw:m[0]+14;cl(lx-2,m[1]-10,lw+4,21);pf(pl[3],lx,m[1]-8,1,.8);pf(fl,lx,m[1]+2,1,.5)}});
  kod(cx,cy,5);ci(cx,cy,2,1,true);
  ln(292,0,292,H,.25,[1,3]);cl(293,0,283,H);
  hdr('sky','live','Sky',300);w=tw('Sky');pf((RV<1?nf:4)+' IN RANGE',342+w,11,1,.5);
  if(acq){pf('ACQUIRING',300,38,1,.5);pf('------'.slice(0,1+Math.floor(T*6)%6),300,49,4,.5,true)}else{pf('NEAREST',300,38,1,.5);pf('XQT472',300,49,4,1,true);arr(458,62,300,1);pf('NW 300°',472,53,1,.6);pf('CLIMBING',472,65,1,.6)}
  [['ALT FT','1,800'],['DIST KM','0.8'],['SPD KT','150']].forEach(function(c,i){pf(c[0],300+i*92,86,1,.5);pf(acq?'-':c[1],300+i*92,97,2,1)});
  ln(386,86,386,111,.3,[1,2]);ln(478,86,478,111,.3,[1,2]);p(300,119,.3,276,1);
  pf('OTHERS',300,125,1,.5);pfr('ALT',500,125,1,.5);pfr('KM',W,125,1,.5);
  PL.slice(1).forEach(function(pl,i){if(RV<1&&rc*360<pl[1])return;var y=134+i*27;tx(pl[3],300,y,2);pfr(pl[4].toLocaleString('en-US'),500,y+7,2,.75);pfr(pl[0].toFixed(1),W,y+7,2,.75)});
  pf('ADS-B  ·  1090 MHZ  ·  PI RECEIVER',300,276,1,.35)}}};

function draw(ctx,app,scr,t){x=ctx;T=t;KO=false;RV=1;x.globalAlpha=1;x.fillStyle=BG;x.fillRect(0,0,W,H);
  if(scr==='intro'){var o=OPEN[app],ms=(t*1000)%(1600+o[0]+3200),r;if(ms<1600){splash(app,ms);return}if(ms<1600+o[0]){r=(ms-1600)/o[0];RV=app==='around'?r*r*(3-2*r):r}scr=o[1]}
  SC[app][scr]()}
function run(cv){var ctx=cv.getContext('2d'),a=cv.getAttribute('data-g2').split('/'),t0=Date.now(),still=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches),id=0;
  function tick(){if(cv.isConnected===false){if(id)clearInterval(id);cv.__g2=0;return}draw(ctx,a[0],a[1],still?(a[1]==='intro'?1.1:3.3):(Date.now()-t0)/1000)}
  if(!still)id=setInterval(tick,110);tick()}
function scan(){var list=document.querySelectorAll('canvas[data-g2]'),i;for(i=0;i<list.length;i++)if(!list[i].__g2){list[i].__g2=1;run(list[i])}}
var api={draw:draw,scan:scan};
if(typeof window!=='undefined')window.G2HUD=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(typeof document!=='undefined'){scan();setInterval(scan,600)}
})();
