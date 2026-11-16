/**
 * Known brands and the company names banks print for them, as data:
 * `cleanMerchant` walks this list in order and the first match wins.
 *
 * Order matters where one name contains another: the specific entry comes
 * first (Instamart before Swiggy, Uber Eats before Uber, JioMart before
 * Jio, LIC Housing Finance before LIC, Amazon Prime before Amazon).
 *
 * Patterns run against the cleaned, upper-cased payee and match whole words
 * only (`b` wraps each in \b…\b), so APOLLO doesn't claim APOLLONIA. A
 * brand word that is also an ordinary word can still misfire ("TRENT HILL
 * SCHOOL"); accepted, as only the label is affected. Keep every pattern a
 * plain alternation: no nested repetition.
 *
 * Brand and company names only, no categories (categorising is the
 * accounting tool's job). Some brands come from the merchant list in the
 * MIT-licensed Sumeetgpt synthetic transaction generator; see
 * THIRD_PARTY_NOTICES.md.
 */

export interface Brand {
  name: string;
  match: RegExp;
}

const b = (name: string, match: RegExp): Brand => ({
  name,
  match: new RegExp(`\\b(?:${match.source})\\b`),
});

export const BRANDS: Brand[] = [
  // Food delivery and restaurants (specific apps before their parents)
  b('Instamart', /INSTAMART/),
  b('Swiggy', /SWIGGY|BUNDL TECHNOLOGIES/),
  b('Uber Eats', /UBER ?EATS/),
  b('Zomato', /ZOMATO/),
  b('EatSure', /EATSURE/),
  b('Faasos', /FAASOS/),
  b('Behrouz Biryani', /BEHROUZ/),
  b('Rebel Foods', /REBEL FOODS/),
  b("Domino's", /DOMINO'?S|JUBILANT FOODWORKS/),
  b("McDonald's", /MCDONALD'?S?/),
  b('KFC', /\bKFC\b/),
  b('Starbucks', /STARBUCKS/),
  b('Pizza Hut', /PIZZA HUT/),
  b('Burger King', /BURGER KING/),
  b('Subway', /\bSUBWAY\b/),
  b('Cafe Coffee Day', /CAFE COFFEE DAY/),
  b('Chaayos', /CHAAYOS/),
  b("Haldiram's", /HALDIRAM'?S?/),
  b('Third Wave Coffee', /THIRD WAVE/),
  b('Chai Point', /CHAI POINT/),
  b('Barbeque Nation', /BARBEQUE NATION/),

  // Groceries
  b('JioMart', /JIOMART/),
  b('BigBasket', /BIGBASKET/),
  b('Blinkit', /BLINKIT/),
  b('Zepto', /\bZEPTO\b/),
  b('DMart', /\bDMART\b|AVENUE SUPERMARTS/),
  b('More', /MORE RETAIL|MORE SUPERMARKET/),
  b("Spencer's", /SPENCER'?S/),
  b("Nature's Basket", /NATURE'?S BASKET/),
  b('Reliance Fresh', /RELIANCE FRESH/),
  b('Star Bazaar', /STAR BAZAAR/),
  b('Ratnadeep', /RATNADEEP/),
  b('Country Delight', /COUNTRY DELIGHT/),
  b('Milkbasket', /MILKBASKET/),
  b('Metro Cash & Carry', /METRO CASH/),

  // Getting around and fuel
  b('Uber', /\bUBER\b/),
  b('Ola', /\bOLA CABS\b|ANI TECHNOLOGIES/),
  b('Rapido', /RAPIDO/),
  b('Namma Yatri', /NAMMA YATRI/),
  b('BluSmart', /BLUSMART/),
  b('Indian Oil', /INDIAN OIL|\bIOCL\b/),
  b('Bharat Petroleum', /BHARAT PETROLEUM|\bBPCL\b/),
  b('HPCL', /\bHPCL\b|HINDUSTAN PETROLEUM/),
  b('Shell', /\bSHELL\b/),

  // Travel
  b('IRCTC', /IRCTC/),
  b('MakeMyTrip', /MAKEMYTRIP/),
  b('Goibibo', /GOIBIBO/),
  b('Cleartrip', /CLEARTRIP/),
  b('IndiGo', /\bINDIGO\b|INTERGLOBE/),
  b('Air India', /AIR INDIA/),
  b('Akasa Air', /\bAKASA\b/),
  b('SpiceJet', /SPICEJET/),
  b('Vistara', /VISTARA/),
  b('redBus', /REDBUS/),
  b('Yatra', /\bYATRA\b/),
  b('ixigo', /\bIXIGO\b/),
  b('OYO', /\bOYO\b/),
  b('Airbnb', /AIRBNB/),
  b('Booking.com', /BOOKING\.COM/),

  // Streaming and software (before Amazon, Google, Jio)
  b('Amazon Prime', /AMAZON PRIME|PRIME VIDEO/),
  b('Audible', /AUDIBLE/),
  b('Netflix', /NETFLIX/),
  b('Spotify', /SPOTIFY/),
  b('YouTube', /YOUTUBE/),
  b('Google Play', /GOOGLE PLAY/),
  b('Google One', /GOOGLE ONE/),
  b('Google Cloud', /GOOGLE CLOUD/),
  b('Apple', /APPLE\.COM|APPLE SERVICES/),
  b('Hotstar', /(?:JIO)?HOTSTAR/),
  b('JioCinema', /JIOCINEMA/),
  b('Sony LIV', /SONY ?LIV/),
  b('ZEE5', /\bZEE5\b/),
  b('Microsoft', /MICROSOFT/),
  b('Adobe', /\bADOBE\b/),
  b('OpenAI', /OPENAI/),
  b('Anthropic', /ANTHROPIC/),

  // Shopping
  b('Amazon', /AMAZON/),
  b('Flipkart', /FLIPKART/),
  b('Myntra', /MYNTRA/),
  b('AJIO', /\bAJIO\b/),
  b('Nykaa', /NYKAA/),
  b('Meesho', /MEESHO/),
  b('Tata CLiQ', /TATA CLIQ/),
  b('Decathlon', /DECATHLON/),
  b('IKEA', /\bIKEA\b/),
  b('Croma', /\bCROMA\b/),
  b('Reliance Digital', /RELIANCE DIGITAL/),
  b('Reliance Trends', /RELIANCE TRENDS/),
  b('Lenskart', /LENSKART/),
  b('Zara', /INDITEX|\bZARA\b/),
  b('H&M', /\bH ?& ?M\b|HENNES/),
  b('Westside', /WESTSIDE/),
  b('Zudio', /ZUDIO/),
  b('Trent', /\bTRENT\b/),
  b('Lifestyle', /LIFESTYLE INTERNATIONAL|LIFESTYLE STORES/),
  b('Max Fashion', /MAX FASHION/),

  // Health
  b('Apollo', /APOLLO/),
  b('PharmEasy', /PHARMEASY/),
  b('Tata 1mg', /TATA 1MG|\b1MG\b/),
  b('Netmeds', /NETMEDS/),
  b('MedPlus', /MEDPLUS/),
  b('Practo', /PRACTO/),
  b('Cult.fit', /CULTFIT|CULT\.FIT/),
  b('Wellness Forever', /WELLNESS FOREVER/),
  b('Fortis', /\bFORTIS\b/),
  b('Manipal Hospitals', /MANIPAL HOSP[A-Z]*/),
  b('Narayana Health', /NARAYANA HEALTH|NARAYANA HRUDAYALAYA/),
  b('Max Healthcare', /MAX HEALTHCARE/),
  b('Columbia Asia', /COLUMBIA ASIA/),

  // Entertainment
  b('BookMyShow', /BOOKMYSHOW/),
  b('PVR', /\bPVR\b/),
  b('INOX', /\bINOX\b/),

  // Education (THINK AND LEARN is BYJU'S; SORTING HAT is Unacademy)
  b("BYJU'S", /BYJU'?S?|THINK AND LEARN/),
  b('Unacademy', /UNACADEMY|SORTING HAT/),
  b('Vedantu', /VEDANTU/),
  b('Coursera', /COURSERA/),
  b('Udemy', /UDEMY/),
  b('Cuemath', /CUEMATH/),
  b('Kumon', /KUMON/),
  b('Kidzee', /KIDZEE/),
  b('EuroKids', /EUROKIDS/),

  // Insurance (LIC Housing Finance is a lender, not LIC)
  b('LIC Housing Finance', /LIC HOUSING/),
  b('LIC', /\bLIC\b|LIFE INSURANCE CORP/),
  b('HDFC ERGO', /HDFC ERGO/),
  b('HDFC Life', /HDFC LIFE/),
  b('ICICI Lombard', /ICICI LOMBARD/),
  b('ICICI Prudential Life', /ICICI PRU[A-Z]* LIFE/),
  b('Star Health', /STAR HEALTH/),
  b('Niva Bupa', /NIVA BUPA/),
  b('Care Health', /CARE HEALTH/),
  b('Policybazaar', /POLICYBAZAAR/),
  b('Bajaj Allianz', /BAJAJ ALLIANZ/),
  b('Acko', /\bACKO\b/),
  b('Go Digit', /GO DIGIT/),

  // Phone, internet, power, gas
  b('Airtel', /\bAIRTEL\b/),
  b('Jio', /RELIANCE JIO|JIO PREPAID|JIO POSTPAID/),
  b('Vodafone Idea', /VODAFONE/),
  b('BSNL', /\bBSNL\b/),
  b('ACT Fibernet', /ACT FIBERNET/),
  b('Hathway', /HATHWAY/),
  b('Tata Play', /TATA PLAY/),
  b('Tata Power', /TATA POWER/),
  b('Adani Electricity', /ADANI ELECTRICITY/),
  b('BESCOM', /BESCOM/),
  b('MSEDCL', /MSEDCL/),
  b('KSEB', /\bKSEB\b/),
  b('TANGEDCO', /TANGEDCO|\bTNEB\b/),
  b('BWSSB', /BWSSB|BANGALORE WATER/),
  b('BSES', /\bBSES\b/),
  b('Mahanagar Gas', /MAHANAGAR GAS/),
  b('Indane', /INDANE/),
  b('HP Gas', /\bHP GAS\b/),
  b('Bharat Gas', /BHARAT GAS/),
];
