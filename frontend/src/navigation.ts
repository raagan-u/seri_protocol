function nextUrl(
  update: (params: URLSearchParams) => void,
  baseHref = window.location.href
): string {
  const url = new URL(baseHref);
  update(url.searchParams);
  return url.toString();
}

export function browseUrl(baseHref?: string): string {
  return nextUrl((params) => {
    params.delete("page");
    params.delete("auction");
    params.delete("bid");
  }, baseHref);
}

export function createAuctionUrl(baseHref?: string): string {
  return nextUrl((params) => {
    params.set("page", "create");
    params.delete("auction");
    params.delete("bid");
  }, baseHref);
}

export function auctionUrl(address: string, baseHref?: string): string {
  return nextUrl((params) => {
    params.delete("page");
    params.set("auction", address);
  }, baseHref);
}

export function goToBrowse() {
  window.location.assign(browseUrl());
}

export function goToCreateAuction() {
  window.location.assign(createAuctionUrl());
}

export function goToAuction(address: string) {
  window.location.assign(auctionUrl(address));
}
