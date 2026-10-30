import { describe, expect, it } from "vitest";
import { normalizeGlobalWallets, fetchGlobalCoinpayWallets } from "@/lib/coinpay-wallet-data";
import { globalWalletProfile, saveGlobalWalletProfile, slotPayoutTarget } from "@/lib/coinpay-wallets";
import { authorizeUrl, newPendingAuth, decodePending, encodePending } from "@/lib/coinpay-signin";
function db(tables: Record<string, Record<string, any>[]>) {
  return { from: (name: string) => {
    const filters: [string, unknown][]=[];let write: Record<string, unknown>|null=null;
    const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;},maybeSingle:async()=>({data:(tables[name]??[]).find(r=>filters.every(([k,v])=>r[k]===v))??null,error:null}),
      upsert:(r:Record<string,unknown>)=>{write=r;return q;},then:(resolve:(v:unknown)=>void)=>{if(write)tables[name]=[write];resolve({error:null});}};
    return q;
  }} as any;
}
const wallet={id:"global-one",address:"0xGlobal",currency:"usdc_pol",label:null};
describe("global CoinPay payout defaults",()=>{
  it("imports active account and global linked wallets only, preserves case-sensitive addresses and exact chains",()=>{
    const row={id:"1",source:"account",is_active:true,cryptocurrency:"SOL",wallet_address:"AbC"};
    const list=normalizeGlobalWallets([row,{...row,id:"2",wallet_address:"abc"},{...row,id:"3",source:"business"},{...row,id:"4",is_active:false},{...row,id:"5",cryptocurrency:"USDC_POL",wallet_address:"0xGlobal"},{...row,id:"6",source:"web_wallet",business_id:null,wallet_address:"Def"},{...row,id:"7",source:"web_wallet",business_id:"business",wallet_address:"Excluded"}]);
    expect(list.map(w=>w.address)).toEqual(["0xGlobal","AbC","abc","Def"]);
    expect(list[0].currency).toBe("usdc_pol");
  });
  it("one global profile overrides old slot addresses for every site, including new ones",async()=>{
    const sb=db({coinpay_identities:[{user_id:"u",coinpay_sub:"s"}],coinpay_wallet_profiles:[{user_id:"u",coinpay_sub:"s",wallets:[wallet],preferred_wallet_id:wallet.id}]});
    for(const slot of [{payout_address:"old-address",payout_currency:"btc"},{}])expect(await slotPayoutTarget(sb,"u",slot)).toMatchObject({ok:true,address:wallet.address,currency:"usdc_pol",source:"coinpay"});
    expect((await globalWalletProfile(sb,"other-user")).wallets).toEqual([]);
  });
  it("fails closed after unlink or an empty sync instead of falling back to an old address",async()=>{
    const tables={coinpay_identities:[] as Record<string,any>[],coinpay_wallet_profiles:[{user_id:"u",coinpay_sub:"s",wallets:[wallet]}]};
    expect(await slotPayoutTarget(db(tables),"u",{payout_address:"old"})).toMatchObject({ok:false});
    tables.coinpay_identities.push({user_id:"u",coinpay_sub:"s"});tables.coinpay_wallet_profiles[0].wallets=[];
    expect(await slotPayoutTarget(db(tables),"u",{payout_address:"old"})).toMatchObject({ok:false});
  });
  it("will not attach another CoinPay subject's wallets to a user",async()=>{
    const tables={coinpay_identities:[{user_id:"u",coinpay_sub:"s"}],coinpay_wallet_profiles:[]};
    await expect(saveGlobalWalletProfile(db(tables),"u","attacker",[wallet])).rejects.toThrow("does not match");
    expect(tables.coinpay_wallet_profiles).toEqual([]);
  });
  it("requests wallet:read explicitly with PKCE and preserves the return page",()=>{
    const p=newPendingAuth("connect","/dashboard/ads/slots?page=3",true);const u=new URL(authorizeUrl({issuer:"https://coinpayportal.com",clientId:"fixture",clientSecret:"unused",siteUrl:"https://crawlproof.com"},p));
    expect(u.searchParams.get("scope")).toBe("openid profile email wallet:read");expect(u.searchParams.get("code_challenge_method")).toBe("S256");expect(decodePending(encodePending(p))).toMatchObject({wallets:true,next:"/dashboard/ads/slots?page=3"});
  });
  it("does not turn provider errors into a successful empty sync",async()=>{
    await expect(fetchGlobalCoinpayWallets("https://coinpayportal.com","fixture",(async()=>new Response(null,{status:403})) as typeof fetch)).rejects.toThrow("permission");
  });
});
