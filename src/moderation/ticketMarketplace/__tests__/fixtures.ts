import type { TicketMarketplaceIntent } from "../classifier.js";

export const TRUE_POSITIVES_BUYING = [
  "Anyone selling?",
  "Anyone got a spare?",
  "Anybody selling Sunday tix?",
  "Any1 selling a wristband",
  "ISO Saturday pass",
  "In search of a Sunday ticket",
  "Looking for 2 weekend passes",
  "Looking to buy a Sunday ticket",
  "Need a Saturday ticket",
  "Want a Sunday pass",
  "Trying to find a Saturday ticket",
  "Trying to get a Sunday pass",
  "if anyone is selling two tickets for saturday please lmk",
  "if anyone is selling two sixtion tickets for saturday please lmk",
  "if anyone selling a ticket lmk",
  "lmk if anyone is selling",
  "please let me know if someone is selling",
  "hey if someone is selling please dm me",
  "does anyone have a spare wristband",
  "anyone have a ticket they're not using?",
  "happy to pay face value for Saturday",
  "will pay face value for a Sunday pass",
  "cherche billet dimanche",
  "je cherche un pass samedi",
  "qqn vend un billet pour samedi?",
  "quelqu'un vend un billet dimanche",
  "je veux acheter un billet",
  "faites-moi savoir si quelqu'un vend",
  "busco entrada sábado",
  "cerco biglietto domenica",
  "suche Ticket für Samstag",
  "zoek kaartje zaterdag",
] as const;

export const TRUE_POSITIVES_SELLING = [
  "Selling 2 Sunday tickets £80 each",
  "1 Saturday pass £70",
  "Spare Sunday wristband, face value",
  "Selling wristband FV",
  "Free Sunday ticket, can't go",
  "vends une place dimanche 70€",
  "Vendo entrada sábado 50€",
  "Verkaufe Ticket Samstag 60€",
  "Selling 2 Sunday tickets, DM me",
  "Spare wristband, DM for price",
  "Can't go, 2 passes available, DM me",
  "Got a spare Saturday ticket, PM me",
  "à vendre: billet dimanche 70€",
  "For sale: 2 Saturday wristbands £80",
] as const;

export const TRUE_NEGATIVES = [
  "What time do Sunday tickets open?",
  "Ticket office queue is insane",
  "Anyone going to the afters?",
  "Sunday lineup looks good",
  "Who's going on Saturday?",
  "What's the ticket situation looking like",
  "Selling my jacket",
  "Selling my old speakers £50",
  "Anyone selling coke?",
  "Looking for a lift to the venue",
  "Need water",
  "Want some food",
  "Selling out fast, grab yours!",
  "The event is selling out",
  "My friend is selling artwork",
  "I was selling last year too",
  "She's selling me on the idea",
  "I need to leave early",
  "Want to meet at the gate?",
  "After the set we should meet",
  "I'm after the headliner set",
  "Got 2 tickets and I'm buzzing!",
  "Just got my tickets!",
  "Finally got tickets for Sunday 🎉",
  "Can't go tonight, see you tomorrow",
  "I can't make it to lunch",
] as const;

export const KNOWN_FALSE_POSITIVES = [] as const;

export const KNOWN_FALSE_NEGATIVES = [] as const;

export const CONFUSIONS = [
  {
    text: "Anyone selling?",
    expected: "buying",
    reason: "Short form; buyer asking about sellers - dominance rule applies.",
  },
  {
    text: "I might be selling my Sunday ticket, not sure yet",
    expected: "selling",
    reason: "Hedged but still seller announcing availability.",
  },
  {
    text: "Sold my ticket already",
    expected: "none",
    reason: "Past tense; no current transaction intent.",
  },
  {
    text: "Anyone got tickets for sale?",
    expected: "buying",
    reason: "Asking if anyone has tickets to sell - buying intent.",
  },
  {
    text: "Tickets for sale - DM me",
    expected: "selling",
    reason: "Declarative seller offer.",
  },
  {
    text: "Is the event sold out?",
    expected: "none",
    reason: "Question about event status, not peer transaction.",
  },
  {
    text: "Anyone selling coke?",
    expected: "none",
    reason: "Off-topic; no ticket/access term.",
  },
  {
    text: "I sold my jacket, now need cash for ticket",
    expected: "buying",
    reason: "`sold` is past tense + `need` + ticket term = buyer.",
  },
  {
    text: "FV only please, no ONO",
    expected: "selling",
    reason: "Marketplace seller setting terms.",
  },
  {
    text: "anyone have a spare",
    expected: "buying",
    reason: "Bare buyer phrase; should fire strong buy regex.",
  },
] as const satisfies ReadonlyArray<{
  text: string;
  expected: TicketMarketplaceIntent;
  reason: string;
}>;

export const ACCEPTED_PRICES = [
  "£50",
  "€50.00",
  "70,00€",
  "50 quid",
  "GBP 50",
  "face value",
  "FV",
  "free",
  "£70-80",
] as const;

export const REJECTED_PRICES = [
  "ONO",
  "DM for price",
  "offers welcome",
  "fvck",
  "5",
] as const;
