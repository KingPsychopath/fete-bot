export const TRUE_POSITIVES_BUYING = [
  "Anyone got a Sunday ticket for sale",
  "Anyone selling?",
  "ISO Saturday pass",
  "cherche billet dimanche",
  "Looking for a wristband for tonight",
] as const;

export const TRUE_POSITIVES_SELLING_WITH_PRICE = [
  "Selling 2 Sunday tickets £80 each",
  "vends une place dimanche 70€",
  "Spare Sunday ticket, face value",
  "1 pass available, FV",
  "Free Sunday ticket, can't go",
] as const;

export const TRUE_POSITIVES_SELLING_NO_PRICE = [
  "Can't go, 2 passes available, DM me",
  "Can't go, Sunday ticket",
  "Spare wristband, DM for price",
] as const;

export const TRUE_NEGATIVES = [
  "What time do Sunday tickets open?",
  "Ticket office queue is long.",
  "Anyone going to the Sunday afters?",
  "Selling my jacket.",
  "I need to leave early.",
  "After the set we should meet.",
  "Got 2 tickets and I'm buzzing!",
  "Can't go tonight, see you tomorrow.",
] as const;

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
