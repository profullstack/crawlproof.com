import { NextResponse, type NextRequest } from "next/server";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { serviceClient } from "@/lib/supabase/service";
import { coinpayConfig, COINPAY_ISSUER, resolveCoinpayUser, supabaseCoinpayStore } from "@/lib/coinpay-signin";
import { fetchGlobalCoinpayWallets } from "@/lib/coinpay-wallet-data";
import { globalWalletProfile, saveGlobalWalletProfile } from "@/lib/coinpay-wallets";
export const runtime="nodejs";
export async function GET(req: NextRequest) {
  const auth=await authenticateBearer(req);if(!auth.ok)return NextResponse.json({error:auth.error},{status:auth.status});
  return NextResponse.json(await globalWalletProfile(serviceClient(),auth.userId),{headers:{"cache-control":"no-store"}});
}
/** Dual authenticated proof: CrawlProof API caller + provider-verified CoinPay token. */
export async function POST(req: NextRequest) {
  const auth=await authenticateBearer(req);if(!auth.ok)return NextResponse.json({error:auth.error},{status:auth.status});
  const body=await req.json().catch(()=>null);const token=body?.coinpay_token;
  if(typeof token!=="string" || !token || token.length>16384)return NextResponse.json({error:"Sign in with the CoinPay CLI first."},{status:400});
  const issuer=coinpayConfig()?.issuer??COINPAY_ISSUER;
  try {
    const headers={authorization:`Bearer ${token}`,accept:"application/json"};
    let response=await fetch(issuer+"/api/oauth/userinfo",{headers,signal:AbortSignal.timeout(15000),cache:"no-store"});
    let claims: {sub:string; email:null;name:null};
    if(response.ok){const info=await response.json();if(typeof info.sub!=="string"||!info.sub)throw Error();claims={sub:info.sub,email:null,name:null};}
    else {
      response=await fetch(issuer+"/api/auth/me",{headers,signal:AbortSignal.timeout(15000),cache:"no-store"});
      if(!response.ok)throw Error();const info=await response.json();if(typeof info.merchant?.id!=="string")throw Error();claims={sub:info.merchant.id,email:null,name:null};
    }
    const wallets=await fetchGlobalCoinpayWallets(issuer,token);
    const sb=serviceClient();const linked=await resolveCoinpayUser({mode:"connect",currentUserId:auth.userId,claims},supabaseCoinpayStore(sb));
    if(!linked.ok)return NextResponse.json({error:linked.error},{status:409});
    await saveGlobalWalletProfile(sb,auth.userId,claims.sub,wallets);
    return NextResponse.json(await globalWalletProfile(sb,auth.userId),{headers:{"cache-control":"no-store"}});
  } catch {return NextResponse.json({error:"Could not verify and sync CoinPay wallets. Sign in again with wallet:read access."},{status:400});}
}
