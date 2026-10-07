const path=require("path"), Module=require("module");
const B=__dirname;
let PRE=[];
class FS{constructor(){this.blocks=PRE.slice();}hasBlocks(){return PRE.length>0;}
loadChain(){return PRE.slice();}loadMempool(){return[];}saveBlock(b){this.blocks.push(b);}
replaceAllBlocks(c){this.blocks=c.slice();}saveCredit(){}saveMempoolTx(){}deleteMempoolTx(){}
getCreditsForAddress(){return[];}close(){}}
const oR=Module._resolveFilename,S=path.join(B,"storage.js");
Module._resolveFilename=function(r,...a){if(r==="./storage"||r==="./storage.js")return S;return oR.call(this,r,...a)};
require.cache[S]={id:S,filename:S,loaded:true,exports:FS};
const CFG=require(path.join(B,"config.js")); CFG.DIFFICULTY=1;
const BC=require(path.join(B,"bbcblockchain.js"));
const {computeBlockHash,difficultyToTargetHex}=BC;
const W=require(path.join(B,"wallet.js"));
function mk(o){const b={...o,nonce:0};const t=difficultyToTargetHex(o.difficulty);
b.hash=computeBlockHash(b);while(b.hash>t){b.nonce++;b.hash=computeBlockHash(b);}return b;}

const G=W.generateWallet();
const T0=Date.now()-90*60*1000;
const g=mk({height:0,timestamp:T0,previousHash:"0".repeat(64),transactions:[],difficulty:1});
PRE=[g];
const chain=new BC();

console.log("saldo gornika przed:", chain.getBalance(G.address));

const ts=T0+480000;
// trudnosc jakiej oczekuje walidator
let TR=1;
{ const p=mk({height:1,timestamp:ts,previousHash:g.hash,transactions:[],difficulty:1});
  const r=chain.receiveBlock(p);
  const m=/oczekiwano (\d+(?:\.\d+)?)/.exec(r.reason||""); if(m) TR=Number(m[1]); }

// BLOK Z PIECIOMA COINBASE, kazda z poprawna kwota 50
const cb=(i)=>({from:null,to:G.address,amount:50,fee:0,type:"coinbase",timestamp:ts+i});
const blok=mk({height:1,timestamp:ts,previousHash:g.hash,
  transactions:[cb(0),cb(1),cb(2),cb(3),cb(4)],difficulty:TR});

const w=chain.receiveBlock(blok);
console.log("");
console.log("BLOK Z 5 TRANSAKCJAMI COINBASE (5 x 50 BbC):");
console.log("  przyjety :", w.accepted);
console.log("  powod    :", w.reason||"-");
console.log("");
if(w.accepted){
  console.log("saldo gornika po   :", chain.getBalance(G.address));
  console.log("");
  console.log("!! LUKA POTWIERDZONA - gornik wybil", chain.getBalance(G.address), "zamiast 50");
} else {
  console.log("ODRZUCONY - kontrola istnieje.");
}

/* ===== REGRESJA: czy JEDNA coinbase nadal przechodzi ===== */
console.log("");
console.log("=== REGRESJA ===");
PRE=[g];
const chain2=new BC();
const dobry=mk({height:1,timestamp:ts,previousHash:g.hash,
  transactions:[cb(0)],difficulty:TR});
const w2=chain2.receiveBlock(dobry);
console.log("blok z JEDNA coinbase:");
console.log("  przyjety :", w2.accepted, w2.reason||"");
console.log("  saldo    :", chain2.getBalance(G.address));

PRE=[g];
const chain3=new BC();
const zero=mk({height:1,timestamp:ts,previousHash:g.hash,
  transactions:[],difficulty:TR});
const w3=chain3.receiveBlock(zero);
console.log("blok BEZ coinbase:");
console.log("  przyjety :", w3.accepted, w3.reason||"");

PRE=[g];
const chain4=new BC();
const w4=chain4.replaceChain([g, blok]);
console.log("replaceChain z 5 coinbase:");
console.log("  przyjety :", w4.accepted, w4.reason||"");

console.log("");

const checks = [
  ["FIVE_COINBASE_REJECTED", w.accepted === false],
  ["ONE_COINBASE_ACCEPTED", w2.accepted === true],
  ["ONE_COINBASE_BALANCE_50", chain2.getBalance(G.address) === 50],
  ["ZERO_COINBASE_REJECTED", w3.accepted === false],
  ["REPLACECHAIN_FIVE_COINBASE_REJECTED", w4.accepted === false]
];

let failed = 0;

for (const [name, ok] of checks) {
  if (ok) {
    console.log("PASS", name);
  } else {
    failed++;
    console.error("FAIL", name);
  }
}

console.log("");
console.log(
  "RESULT COINBASE:",
  (checks.length - failed) + "/" + checks.length,
  "PASS"
);

if (failed > 0) {
  process.exitCode = 1;
}
