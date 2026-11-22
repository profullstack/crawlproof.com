/** Who CoinPay sees calling: every fleet app shares one host and one IP. */
export const COINPAY_UA = `crawlproof.com${process.env.npm_package_version ? `/${process.env.npm_package_version}` : ""} (+https://crawlproof.com)`;
