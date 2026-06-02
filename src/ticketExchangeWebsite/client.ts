export type WebsiteTicketExchangeListing = {
  id: string;
  eventKey: string;
  eventSlug: string;
  eventName: string;
  eventDateLabel?: string;
  listingType: "selling" | "looking";
  quantityLabel: string;
  priceLabel: string;
  note: string;
  expiresAt: string;
  createdAt: string;
  url: string;
};

type RecentListingsResponse = {
  success: boolean;
  listings?: WebsiteTicketExchangeListing[];
  error?: string;
};

type ListingStatusResponse = {
  success: boolean;
  announceable?: boolean;
  error?: string;
};

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;

export const fetchWebsiteTicketExchangeListings = async (input: {
  baseUrl: string;
  secret: string;
  limit: number;
}): Promise<WebsiteTicketExchangeListing[]> => {
  const url = new URL(joinUrl(input.baseUrl, "/api/ticket-exchange/bot/recent-listings"));
  url.searchParams.set("limit", `${Math.min(20, Math.max(1, input.limit))}`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.secret}`,
    },
  });
  const body = (await response.json()) as RecentListingsResponse;
  if (!response.ok || !body.success) {
    throw new Error(body.error || `Ticket Exchange feed failed with ${response.status}`);
  }
  return body.listings ?? [];
};

export const markWebsiteTicketExchangeListingAnnounced = async (input: {
  baseUrl: string;
  secret: string;
  listingId: string;
}): Promise<void> => {
  const response = await fetch(joinUrl(input.baseUrl, "/api/ticket-exchange/bot/announce-callback"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ listingId: input.listingId }),
  });
  if (!response.ok) {
    throw new Error(`Ticket Exchange announce callback failed with ${response.status}`);
  }
};

export const isWebsiteTicketExchangeListingAnnounceable = async (input: {
  baseUrl: string;
  secret: string;
  listingId: string;
}): Promise<boolean> => {
  const response = await fetch(
    joinUrl(input.baseUrl, `/api/ticket-exchange/bot/listings/${encodeURIComponent(input.listingId)}/status`),
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.secret}`,
      },
    },
  );
  const body = (await response.json()) as ListingStatusResponse;
  if (!response.ok || !body.success) {
    throw new Error(body.error || `Ticket Exchange listing status failed with ${response.status}`);
  }
  return Boolean(body.announceable);
};
