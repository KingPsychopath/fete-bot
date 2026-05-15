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
  "Searching for a Saturday ticket",
  "Seeking a Sunday pass",
  "Need a Saturday ticket",
  "Want a Sunday pass",
  "Trying to find a Saturday ticket",
  "Trying to get a Sunday pass",
  "WTB 2 Friday tickets",
  "Ticket wanted for Sunday",
  "Any spares for Saturday?",
  "Any spare ticket going?",
  "if anyone is selling two tickets for saturday please lmk",
  "if anyone is selling two sixtion tickets for saturday please lmk",
  "Heyy, anyone selling 4 Zsongo all white party tickets?",
  "if anyone selling a ticket lmk",
  "lmk if anyone is selling",
  "please let me know if someone is selling",
  "hey if someone is selling please dm me",
  "can someone sell me 2 tickets",
  "please sell me a ticket",
  "someone sell me a ticket please",
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
  "selling 2x recessland tickets Saturday for those interested £35",
  "selling 2x recessland Saturday for those interested £35",
  "anyone looking for 2 recess saturday tickets?",
  "anyone looking to buy 2 recess saturday tickets?",
  "anyone need 2 recess saturday tickets?",
  "have 2 recess saturday tickets available",
  "have 2 recess saturday tickets dm me",
  "can’t make it, 2 recess saturday £35",
  "Selling my ticket",
  "I am selling a ticket",
  "1 Saturday pass £70",
  "Spare Sunday wristband, face value",
  "Selling wristband FV",
  "Free Sunday ticket, can't go",
  "vends une place dimanche 70€",
  "Vendo entrada sábado 50€",
  "Verkaufe Ticket Samstag 60€",
  "Selling 2 Sunday tickets, DM me",
  "Spare wristband, DM for price",
  "Can't go, 2 Sunday passes available, DM me",
  "Can't make it anymore, selling my Sunday ticket",
  "Got a spare Saturday ticket, PM me",
  "Have 2 tickets available £80 each",
  "Letting go of 2 Sunday tickets face value",
  "My friend is selling a ticket, DM me",
  "Posting for a mate, 2 tickets available £80",
  "Posting for a friend, Sunday ticket available FV",
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
  "I don't want to book tickets for events or clubs, I just want to go somewhere and see for myself",
  "I do not want to buy tickets, I just want to see what is happening",
  "I think I’m leaning towards just going with the flow and not buying any tickets at all",
  "I'm not looking to buy tickets, just asking what people are doing later",
  "Looking for ticket advice",
  "Looking for ticket info",
  "After the set we should meet",
  "I'm after the headliner set",
  "Got 2 tickets and I'm buzzing!",
  "Anyone looking for 2 people for Saturday tickets?",
  "got 2 tickets and can sell me on saturday plans",
  "Just got my tickets!",
  "Finally got tickets for Sunday 🎉",
  "Can't go tonight, see you tomorrow",
  "I can't make it to lunch",
  "buy that lime pass easy peasy",
  "Looking for a lime pass",
  "Looking for 2 passes",
  "Need a train pass for tomorrow",
  "Want a gym pass for next week",
  "ISO train pass",
  "Does anyone know what the ticket la machine commu means?",
  "These ppl tryna sell me 100€ for 2 tickets on 21st. Im not selling, Im complaining",
  "Someone tried to sell me 2 tickets for 100",
  "They are selling me a ticket for £50",
  "People are asking 100 for 2 tickets",
  "Are people selling tickets for 100?",
  "Whys everyone selling their event tickets?",
  "Why am I selling my ticket?",
  "Why is my mate selling a ticket?",
  "People selling tickets for 100 is crazy",
  "Are tickets selling for 100?",
  "Tickets are selling fast",
  "These resale prices are ridiculous",
  "Scammer tried to sell me a fake ticket",
  "Just venting about ticket prices",
  "Not selling my ticket, just complaining about the prices",
] as const;

export const FALSE_POSITIVE_REGRESSIONS = [
  {
    text: "Hey everyone! I found a place in the 10th for six guests, looking for 4 more ppl and the price would be around £300 to £400 per person. The dates are from June 18th to June 23rd. Ideally, I’d love to get the payments in by next week or atleast before june, the sooner, the better, so we can secure the booking. Accoms are on the nicer side dm me if you would like pics. As for the sleeping arrangements, there will be double beds, so I’d suggest bringing a friend if you’re not comfortable sharing with someone you haven’t met yet.",
    expected: "none",
    layer: "classifier",
    reason: "Accommodation coordination can contain place, price, payment, and DM language without being ticket resale.",
  },
  {
    text: "Hey Everyone, if anyone is looking for somewhere to stay for fdlm please lmk. Staying near Châtelet for six guests, and the price would be around £300 to £400 per person. The dates are from June 18th to June 23rd.",
    expected: "none",
    layer: "classifier",
    reason: "Short accommodation offers can contain lmk, guests, price per person, and dates without being ticket resale.",
  },
] as const satisfies ReadonlyArray<{
  text: string;
  expected: TicketMarketplaceIntent;
  layer: "classifier" | "routing";
  reason: string;
}>;

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
  {
    text: "not selling for less than 100, ticket available",
    expected: "selling",
    reason: "Negotiation wording still announces ticket availability.",
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
