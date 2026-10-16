import type { Emirate } from '@/types';

/**
 * Residential communities and districts of every emirate, as customers type them.
 *
 * Used by checkout to *suggest* an area (the customer can always type any area), by "Drop pin" for
 * the communities whose centre we know, and by the delivery check so "JVC" and
 * "Jumeirah Village Circle (JVC)" are the same place in Settings → Delivery → areas not served.
 *
 * Coordinates are only given where we are sure of a community's centre (a GPS reading is matched to
 * the nearest one within 1.5 km); a point is left out rather than guessed.
 */
export interface UAEArea {
  name: string;
  emirate: Emirate;
  /** Other spellings and short names customers type ("JVC", "Tecom", "Akoya"). */
  aliases?: string[];
  /** A town or region within the emirate (Al Ain, Al Dhafra, Hatta…), shown as a hint. */
  region?: string;
  lat?: number;
  lng?: number;
}

type Row = [name: string, aliases?: string[] | null, coords?: [number, number] | null, region?: string];

const DUBAI: Row[] = [
  // Coast: Marina, JBR, JLT, Palm and around
  ['Dubai Marina', ['Marina'], [25.0772, 55.1396]],
  ['Jumeirah Beach Residence (JBR)', ['JBR', 'Jumeirah Beach Residence'], [25.0805, 55.1364]],
  ['Jumeirah Lake Towers (JLT)', ['JLT', 'Jumeirah Lakes Towers'], [25.0693, 55.1418]],
  ['Palm Jumeirah', ['The Palm', 'Palm'], [25.1124, 55.139]],
  ['Bluewaters Island', ['Bluewaters'], [25.0805, 55.1205]],
  ['Dubai Harbour', null],
  ['Emaar Beachfront', null],
  ['Dubai Media City', ['DMC', 'Media City'], [25.0925, 55.154]],
  ['Dubai Internet City', ['DIC', 'Internet City'], [25.0957, 55.16]],
  ['Dubai Knowledge Park', ['Knowledge Village']],
  ['Al Sufouh', ['Sufouh']],
  ['Barsha Heights (Tecom)', ['Tecom', 'Barsha Heights'], [25.097, 55.177]],
  ['The Greens', ['Greens'], [25.096, 55.172]],
  ['The Views', ['Views']],
  ['Emirates Hills', null],
  ['The Meadows', ['Meadows', 'Emirates Living']],
  ['The Springs', ['Springs', 'Emirates Living']],
  ['The Lakes', ['Lakes', 'Emirates Living']],
  ['Jumeirah Islands', null],
  ['Jumeirah Park', null],
  ['Jumeirah Heights', null],
  ['Jumeirah Golf Estates', ['JGE']],
  ['Al Furjan', ['Furjan'], [25.028, 55.148]],
  ['Discovery Gardens', ['Discovery Garden', 'DG'], [25.04, 55.145]],
  ['The Gardens', ['Gardens', 'Jebel Ali Gardens']],
  ['Ibn Battuta', ['Ibn Battuta Mall', 'Ibn Batuta'], [25.0445, 55.119]],
  ['Jebel Ali', ['Jebel Ali Village', 'Jabal Ali']],
  ['Jebel Ali Industrial', ['JAI']],
  ['Jebel Ali Free Zone (JAFZA)', ['JAFZA', 'Jebel Ali Free Zone']],
  ['Dubai Investments Park (DIP)', ['DIP', 'Dubai Investment Park'], [24.99, 55.17]],
  ['Green Community', null],
  ['Dubai Production City (IMPZ)', ['IMPZ', 'Production City']],
  ['Jumeirah Village Circle (JVC)', ['JVC', 'Jumeirah Village'], [25.0597, 55.2078]],
  ['Jumeirah Village Triangle (JVT)', ['JVT'], [25.046, 55.19]],
  ['Al Barsha', ['Barsha', 'Al Barsha 1', 'Al Barsha 2', 'Al Barsha 3'], [25.1118, 55.2039]],
  ['Al Barsha South', null],
  ['Dubai Sports City', ['Sports City', 'DSC'], [25.04, 55.218]],
  ['Motor City', null, [25.046, 55.237]],
  ['Dubai Studio City', ['Studio City']],
  ['Arjan', ['Al Barsha South 3']],
  ['Dubai Science Park', ['Dubiotech']],
  ['Al Barari', ['Barari']],
  ['Majan', null],
  ['Liwan', null],
  ['Remraam', null],
  ['Mudon', null],
  ['Town Square', ['Nshama', 'Town Square Dubai']],
  ['Living Legends', null],
  ['Falcon City of Wonders', ['Falcon City']],
  ['Dubailand', ['Dubai Land']],
  ['The Villa', ['The Villa Project']],
  ['Al Waha Community', ['Al Waha']],
  ['Arabian Ranches', ['Ranches', 'Arabian Ranches 1'], [25.0534, 55.2655]],
  ['Arabian Ranches 2', null],
  ['Arabian Ranches 3', null],
  ['Damac Hills', ['Akoya', 'Damac Hills 1'], [25.025, 55.25]],
  ['Damac Hills 2', ['Akoya Oxygen', 'Damac Akoya Oxygen']],
  ['Damac Lagoons', null],
  ['The Sustainable City', ['Sustainable City']],
  ['Serena', null],
  ['Mira', null],
  ['Mira Oasis', null],
  ['Reem Community', null],
  ['Villanova', null],
  ['Tilal Al Ghaf', null],
  ['The Valley', ['The Valley Emaar']],
  ['Dubai Hills Estate', ['Dubai Hills'], [25.1122, 55.2536]],
  ['Mohammed Bin Rashid City (MBR City)', ['MBR City', 'MBR', 'Mohammed Bin Rashid City']],
  ['District One', ['MBR District One']],
  ['Sobha Hartland', null],
  ['Meydan', ['Meydan City'], [25.158, 55.3]],
  ['Nad Al Sheba', null],
  ['Al Quoz', ['Al Qouz', 'Al Quoz 1', 'Al Quoz 2', 'Al Quoz 3', 'Al Quoz 4'], [25.14, 55.235]],
  ['Al Quoz Industrial', ['Al Quoz Industrial Area']],
  ['Al Khail Gate', null],
  ['Al Safa', ['Al Safa 1', 'Al Safa 2'], [25.18, 55.235]],
  ['Al Manara', null],
  ['Umm Suqeim', ['Umm Suqeim 1', 'Umm Suqeim 2', 'Umm Suqeim 3', 'Umm Suqueim'], [25.148, 55.21]],
  ['Umm Al Sheif', null],
  ['Al Wasl', ['Wasl'], [25.195, 55.255]],
  ['Jumeirah 1', ['Jumeira 1'], [25.222, 55.258]],
  ['Jumeirah 2', ['Jumeira 2']],
  ['Jumeirah 3', ['Jumeira 3']],
  ['La Mer', null],
  ['Pearl Jumeira', ['Pearl Jumeirah']],
  ['City Walk', ['Citywalk'], [25.206, 55.262]],
  ['Al Satwa', ['Satwa'], [25.226, 55.274]],
  ['Al Bada’a', ['Al Badaa', 'Bada']],
  ['Al Hudaiba', null],
  ['Al Jafiliya', ['Jafiliya', 'Jafliya']],
  ['Downtown Dubai', ['Downtown', 'Burj Khalifa'], [25.1972, 55.2744]],
  ['Business Bay', null, [25.1837, 55.2666]],
  ['Dubai International Financial Centre (DIFC)', ['DIFC'], [25.212, 55.281]],
  ['Trade Centre', ['World Trade Centre', 'DWTC', 'Sheikh Zayed Road'], [25.225, 55.285]],
  ['Za’abeel', ['Zabeel', 'Zaabeel']],
  ['Al Kifaf', null],
  ['Dubai Design District (d3)', ['d3', 'Dubai Design District']],
  ['Al Jaddaf', ['Jaddaf', 'Jaddaf Waterfront'], [25.22, 55.33]],
  ['Culture Village', null],
  ['Dubai Healthcare City', ['DHCC', 'Healthcare City'], [25.231, 55.323]],
  ['Oud Metha', null, [25.235, 55.313]],
  ['Umm Hurair', null],
  ['Al Karama', ['Karama'], [25.245, 55.304]],
  ['Al Mankhool', ['Mankhool']],
  ['Al Raffa', ['Raffa']],
  ['Bur Dubai', null, [25.2532, 55.2974]],
  ['Al Fahidi', ['Bastakiya', 'Al Bastakiya']],
  ['Al Souq Al Kabeer', ['Meena Bazaar']],
  ['Al Shindagha', ['Shindagha']],
  ['Al Hamriya', null],
  ['Mina Rashid', ['Port Rashid']],
  ['Dubai Maritime City', null],
  ['Deira', null, [25.2697, 55.3095]],
  ['Al Rigga', ['Rigga'], [25.263, 55.322]],
  ['Al Muraqqabat', ['Muraqqabat']],
  ['Naif', ['Al Naif']],
  ['Al Sabkha', ['Sabkha']],
  ['Al Murar', ['Murar']],
  ['Al Ras', null],
  ['Al Baraha', ['Baraha']],
  ['Al Muteena', ['Muteena']],
  ['Abu Hail', null],
  ['Hor Al Anz', ['Hor Al Anz East']],
  ['Al Khabaisi', null],
  ['Port Saeed', null],
  ['Al Garhoud', ['Garhoud'], [25.243, 55.348]],
  ['Umm Ramool', null],
  ['Al Mamzar', ['Mamzar']],
  ['Al Waheda', null],
  ['Al Qusais', ['Qusais', 'Al Qusais 1', 'Al Qusais 2', 'Al Qusais Industrial'], [25.28, 55.38]],
  ['Al Nahda (Dubai)', ['Al Nahda', 'Al Nahda 1', 'Al Nahda 2'], [25.29, 55.37]],
  ['Al Twar', ['Twar']],
  ['Al Muhaisnah', ['Muhaisnah', 'Mhaisnah', 'Sonapur']],
  ['Al Mizhar', ['Mizhar']],
  ['Mirdif', ['Mirdiff', 'Uptown Mirdif'], [25.2167, 55.4167]],
  ['Al Khawaneej', ['Khawaneej']],
  ['Al Rashidiya', ['Rashidiya']],
  ['Nad Al Hamar', null],
  ['Al Warqa', ['Warqa', 'Al Warqaa']],
  ['Ras Al Khor', null],
  ['Dubai Festival City', ['Festival City', 'DFC'], [25.2225, 55.352]],
  ['Dubai Creek Harbour', ['Creek Harbour', 'Creek Beach'], [25.205, 55.345]],
  ['Dubai Islands', ['Deira Islands']],
  ['International City', ['Dragon Mart', 'Intl City'], [25.163, 55.408]],
  ['Warsan', ['Al Warsan']],
  ['Dubai Silicon Oasis', ['DSO', 'Silicon Oasis'], [25.1245, 55.3789]],
  ['Dubai Academic City', ['Academic City']],
  ['Al Awir', ['Al Aweer']],
  ['Al Lisaili', null],
  ['Dubai South', ['Dubai World Central', 'DWC']],
  ['Emaar South', null],
  ['Expo City Dubai', ['Expo City', 'Expo 2020'], [24.963, 55.149]],
  ['Dubai Industrial City', ['Saih Shuaib']],
  ['Al Habtoor City', null],
  ['Jumeirah Bay Island', ['Bulgari Island']],
  ['Madinat Jumeirah Living', ['MJL']],
  ['Dubailand Residence Complex (DLRC)', ['DLRC', 'Dubai Land Residence Complex']],
  ['Wadi Al Safa', null],
  ['Al Hebiah', null],
  ['Al Thanyah', null],
  ['Me’aisem', ['Meaisem', 'Al Meaisem']],
  ['Al Qudra', null],
  ['Hatta', null, [24.799, 56.117], 'Hatta'],
];

const ABU_DHABI: Row[] = [
  // Abu Dhabi city and islands
  ['Corniche', ['Abu Dhabi Corniche', 'Downtown Abu Dhabi'], [24.4697, 54.3435]],
  ['Al Khalidiyah', ['Khalidiya', 'Al Khalidiya']],
  ['Al Bateen', ['Bateen']],
  ['Al Mushrif', ['Mushrif']],
  ['Al Karamah', null],
  ['Al Manhal', null],
  ['Al Nahyan', ['Al Nahyan Camp']],
  ['Al Wahdah', null],
  ['Al Zahiyah', ['Tourist Club Area', 'TCA']],
  ['Al Markaziyah', ['Markaziya']],
  ['Al Danah', null],
  ['Al Khubeirah', null],
  ['Al Ras Al Akhdar', null],
  ['Al Muroor', ['Muroor']],
  ['Al Mina', ['Mina Zayed', 'Port Zayed']],
  ['Al Maryah Island', ['Maryah Island'], [24.501, 54.39]],
  ['Al Reem Island', ['Reem Island'], [24.4975, 54.4069]],
  ['Saadiyat Island', ['Saadiyat'], [24.5422, 54.4372]],
  ['Yas Island', ['Yas'], [24.4962, 54.6064]],
  ['Al Raha Beach', ['Raha Beach', 'Al Bandar', 'Al Muneera'], [24.452, 54.6]],
  ['Al Raha Gardens', ['Raha Gardens']],
  ['Al Rawdah', null],
  ['Al Safarat', ['Embassies Area', 'Diplomatic Area']],
  ['Al Maqtaa', null],
  ['Bain Al Jessrain', ['Between Two Bridges']],
  ['Al Hudayriat Island', ['Hudayriyat']],
  ['Khalifa City', ['Khalifa City A'], [24.4258, 54.58]],
  ['Masdar City', ['Masdar'], [24.427, 54.615]],
  ['Mohammed Bin Zayed City (MBZ)', ['MBZ', 'MBZ City', 'Mohammed Bin Zayed City']],
  ['Mussafah', ['Musaffah', 'ICAD']],
  ['Shakhbout City', ['Khalifa City B']],
  ['Baniyas', ['Bani Yas']],
  ['Al Shamkha', ['Shamkha']],
  ['Al Falah', null],
  ['Al Rahba', null],
  ['Al Reef', ['Al Reef Villas']],
  ['Al Ghadeer', null],
  ['Al Bahia', null],
  ['Al Shahama', ['Shahama']],
  ['Al Samha', null],
  ['Al Wathba', null],
  ['Al Mafraq', null],
  ['Zayed City', ['Madinat Zayed Abu Dhabi']],
  // Al Ain
  ['Al Ain City Centre', ['Al Ain', 'Al Ain Central'], [24.2075, 55.7447], 'Al Ain'],
  ['Al Jimi', null, null, 'Al Ain'],
  ['Al Muwaiji', null, null, 'Al Ain'],
  ['Al Towayya', null, null, 'Al Ain'],
  ['Al Khabisi', null, null, 'Al Ain'],
  ['Al Hili', ['Hili'], null, 'Al Ain'],
  ['Al Maqam', null, null, 'Al Ain'],
  ['Al Mutaredh', null, null, 'Al Ain'],
  ['Al Jahili', null, null, 'Al Ain'],
  ['Al Mutawaa', null, null, 'Al Ain'],
  ['Al Qattara', null, null, 'Al Ain'],
  ['Zakher', null, null, 'Al Ain'],
  ['Al Foah', null, null, 'Al Ain'],
  ['Al Yahar', null, null, 'Al Ain'],
  ['Al Markhaniya', null, null, 'Al Ain'],
  ['Asharej', null, null, 'Al Ain'],
  ['Falaj Hazza', null, null, 'Al Ain'],
  ['Al Sarooj', null, null, 'Al Ain'],
  ['Al Masoudi', null, null, 'Al Ain'],
  // Al Dhafra
  ['Madinat Zayed', ['Bida Zayed'], null, 'Al Dhafra'],
  ['Ruwais', ['Al Ruwais'], null, 'Al Dhafra'],
  ['Ghayathi', null, null, 'Al Dhafra'],
  ['Liwa', ['Mezairaa', 'Liwa Oasis'], null, 'Al Dhafra'],
  ['Mirfa', ['Al Mirfa'], null, 'Al Dhafra'],
  ['Sila', ['Al Sila'], null, 'Al Dhafra'],
  ['Delma Island', ['Delma', 'Dalma'], null, 'Al Dhafra'],
  ['Sir Bani Yas Island', ['Sir Bani Yas'], null, 'Al Dhafra'],
];

const SHARJAH: Row[] = [
  ['Al Majaz', ['Majaz', 'Al Majaz Waterfront', 'Al Majaz 1', 'Al Majaz 2', 'Al Majaz 3'], [25.3283, 55.3854]],
  ['Al Nahda (Sharjah)', ['Al Nahda'], [25.3012, 55.3725]],
  ['Al Taawun', ['Taawun', 'Al Taawon'], [25.3167, 55.3722]],
  ['Al Khan', ['Khan']],
  ['Al Qasimia', ['Qasimia', 'Al Qasimiya']],
  ['Abu Shagara', ['Abu Shaghara']],
  ['Al Mujarrah', ['Al Majarrah']],
  ['Rolla', ['Al Rolla']],
  ['Al Ghuwair', null],
  ['Al Soor', null],
  ['Al Shuwaihean', null],
  ['Al Heerah', ['Al Heerah Beach']],
  ['Al Ramtha', null],
  ['Al Fisht', null],
  ['Al Layyeh', null],
  ['Al Khalidiya (Sharjah)', ['Al Khalidiya']],
  ['Al Qadisiya', null],
  ['Al Azra', null],
  ['Al Yarmook', null],
  ['Al Nud', null],
  ['Al Ghubaiba', null],
  ['Al Mirgab', null],
  ['Al Sharq', null],
  ['Al Gharb', null],
  ['Al Butina', null],
  ['Al Jazzat', null],
  ['Al Nekhailat', null],
  ['Al Fayha', null],
  ['Al Mansoura', null],
  ['Maysaloon', null],
  ['Al Shahba', null],
  ['Halwan', null],
  ['Al Nasserya', null],
  ['Samnan', null],
  ['Al Yash', null],
  ['Al Nouf', null],
  ['Muwaileh', ['Muwailih', 'Muwaileh Commercial', 'Muwailih Commercial'], [25.306, 55.459]],
  ['Al Jurainah', null],
  ['University City', ['University City Sharjah']],
  ['Aljada', ['Al Jada']],
  ['Al Rahmaniya', null],
  ['Al Suyoh', null],
  ['Al Zahia', ['Zahia']],
  ['Al Tai', null],
  ['Tilal City', null],
  ['Sharjah Industrial Area', ['Industrial Area', 'Al Sajaa Industrial']],
  ['Al Sajaa', null],
  ['Al Hamriyah', null],
  ['Al Dhaid', ['Dhaid'], null, 'Central region'],
  ['Mleiha', null, null, 'Central region'],
  ['Kalba', null, null, 'East coast'],
  ['Khor Fakkan', ['Khorfakkan'], null, 'East coast'],
  ['Dibba Al Hisn', null, null, 'East coast'],
];

const AJMAN: Row[] = [
  ['Ajman Corniche', ['Corniche'], [25.4111, 55.435]],
  ['Al Nuaimiya', ['Nuaimiya', 'Al Nuaimia', 'Al Nuaimiya 1', 'Al Nuaimiya 2', 'Al Nuaimiya 3'], [25.3875, 55.456]],
  ['Al Rashidiya (Ajman)', ['Al Rashidiya']],
  ['Al Rumailah', null],
  ['Al Bustan', null],
  ['Al Nakhil', null],
  ['Al Jurf', ['Al Jerf', 'Al Jurf Industrial']],
  ['Al Rawda', null],
  ['Al Mowaihat', ['Mowaihat']],
  ['Al Hamidiya', null],
  ['Al Zahra', null],
  ['Al Tallah', null],
  ['Al Yasmeen', null],
  ['Al Helio', null],
  ['Al Amerah', null],
  ['Al Alia', null],
  ['Al Zorah', null],
  ['Emirates City', null],
  ['Garden City', null],
  ['Mushairif', null],
  ['Al Sawan', null],
  ['Masfout', null],
  ['Manama (Ajman)', ['Manama']],
];

const RAK: Row[] = [
  ['Al Hamra Village', ['Al Hamra'], [25.6989, 55.7878]],
  ['Al Marjan Island', ['Marjan Island'], [25.68, 55.74]],
  ['Mina Al Arab', null],
  ['Al Nakheel', null],
  ['Al Dhait', ['Dhait']],
  ['Khuzam', null],
  ['Al Mamourah', null],
  ['Al Qusaidat', null],
  ['Seih Al Uraibi', ['Al Uraibi']],
  ['Al Seer', null],
  ['Julphar', null],
  ['Corniche Al Qawasim', ['RAK Corniche']],
  ['Al Mairid', null],
  ['Al Kharran', null],
  ['Al Jazirah Al Hamra', ['Al Jazeera Al Hamra']],
  ['Al Rams', null],
  ['Al Dhaya', ['Dhayah']],
  ['Shamal', null],
  ['Digdagga', null],
  ['Khatt', null],
  ['Al Ghail', null],
  ['Ras Al Khaimah Old Town', ['RAK City', 'Old Ras Al Khaimah']],
];

const FUJAIRAH: Row[] = [
  ['Fujairah City', ['Fujairah City Centre', 'Fujairah City Center'], [25.1288, 56.3265]],
  ['Fujairah Corniche', ['Fujairah Beach']],
  ['Al Faseel', null],
  ['Merashid', null],
  ['Sakamkam', null],
  ['Al Gurfa', null],
  ['Madhab', null],
  ['Al Hayl', ['Al Hail']],
  ['Qidfa', null],
  ['Mirbah', null],
  ['Al Bidiyah', ['Bidya']],
  ['Al Aqah', ['Aqah']],
  ['Dadna', null],
  ['Dibba Al Fujairah', ['Dibba']],
  ['Masafi', null],
];

const UAQ: Row[] = [
  ['Umm Al Quwain Old Town', ['UAQ City', 'Umm Al Quwain City']],
  ['Al Salamah', ['Al Salama'], [25.5647, 55.5552]],
  ['Umm Al Quwain Marina', ['UAQ Marina']],
  ['Al Raas', null],
  ['Al Humrah', null],
  ['Al Ramlah', null],
  ['Al Maidan', null],
  ['Al Raudah', null],
  ['Al Haditha', null],
  ['Al Riqqah', null],
  ['Al Rafaah', null],
  ['Falaj Al Mualla', null],
  ['Al Sinniyah Island', ['Sinniyah']],
  ['Al Abraq', null],
  ['Emirates Modern Industrial Area', ['UAQ Industrial Area']],
];

function rows(emirate: Emirate, list: Row[]): UAEArea[] {
  return list.map(([name, aliases, coords, region]) => ({
    name,
    emirate,
    ...(aliases?.length ? { aliases } : {}),
    ...(region ? { region } : {}),
    ...(coords ? { lat: coords[0], lng: coords[1] } : {}),
  }));
}

export const UAE_AREAS: UAEArea[] = [
  ...rows('Dubai', DUBAI),
  ...rows('Abu Dhabi', ABU_DHABI),
  ...rows('Sharjah', SHARJAH),
  ...rows('Ajman', AJMAN),
  ...rows('Ras Al Khaimah', RAK),
  ...rows('Fujairah', FUJAIRAH),
  ...rows('Umm Al Quwain', UAQ),
];

/** Lowercase, no accents, apostrophes or punctuation: "Za’abeel" and "zaabeel" match. */
export function normArea(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`‘]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface Indexed {
  area: UAEArea;
  name: string;
  aliases: string[];
  /** The aliases as written, for showing which one matched. */
  raw: string[];
}
// "Jumeirah Village Circle (JVC)" is also found as "Jumeirah Village Circle".
const INDEX: Indexed[] = UAE_AREAS.map((area) => {
  const bare = area.name.replace(/\s*\([^)]*\)$/, '');
  const raw = [...(area.aliases ?? []), ...(bare !== area.name ? [bare] : [])];
  return { area, name: normArea(area.name), aliases: raw.map(normArea), raw };
});

/** The areas of one emirate, in the order above. */
export function areasOf(emirate: Emirate): UAEArea[] {
  return UAE_AREAS.filter((a) => a.emirate === emirate);
}

/**
 * The area a customer or the owner typed, by its exact name or an alias ("JVC"), ignoring case and
 * punctuation. A name used in two emirates (Al Nahda) resolves to the one in `emirate`.
 */
export function resolveArea(text: string, emirate?: string): UAEArea | null {
  const q = normArea(text);
  if (!q) return null;
  const pick = (hits: UAEArea[]) => {
    const here = hits.filter((a) => a.emirate === emirate);
    const from = here.length ? here : hits;
    // An alias shared by two places in one emirate ("Emirates Living") names neither.
    return from.length === 1 ? from[0] : null;
  };
  const byName = INDEX.filter((i) => i.name === q).map((i) => i.area);
  if (byName.length) return pick(byName) ?? byName.find((a) => a.emirate === emirate) ?? byName[0];
  return pick(INDEX.filter((i) => i.aliases.includes(q)).map((i) => i.area));
}

/** A stable key for an area ("Dubai|Discovery Gardens"). */
export const areaKey = (a: UAEArea) => `${a.emirate}|${a.name}`;

export interface AreaMatch {
  area: UAEArea;
  /** The alias that matched, when the name itself didn't ("JVC"). */
  via?: string;
}

/**
 * Areas matching any part of a name or alias, case-insensitive: the chosen emirate's first, then the
 * others. Within each, names starting with the text, then a word starting with it, then anywhere.
 * An empty query lists the chosen emirate's areas.
 */
export function searchAreas(query: string, emirate: string, limit = 60): AreaMatch[] {
  const q = normArea(query);
  if (!q) return UAE_AREAS.filter((a) => a.emirate === emirate).slice(0, limit).map((area) => ({ area }));
  const scored: { m: AreaMatch; score: number }[] = [];
  const rank = (s: string) => (s.startsWith(q) ? 0 : s.includes(` ${q}`) ? 1 : s.includes(q) ? 2 : -1);
  for (const i of INDEX) {
    let score = rank(i.name);
    let via: string | undefined;
    if (score < 0) {
      for (let k = 0; k < i.aliases.length; k++) {
        const r = rank(i.aliases[k]);
        if (r >= 0 && (score < 0 || r < score)) {
          score = r;
          via = i.raw[k];
        }
      }
      if (score >= 0) score += 0.5;
    }
    if (score < 0) continue;
    if (i.area.emirate !== emirate) score += 10;
    scored.push({ m: { area: i.area, ...(via ? { via } : {}) }, score });
  }
  scored.sort((a, b) => a.score - b.score || a.m.area.name.localeCompare(b.m.area.name));
  return scored.slice(0, limit).map((s) => s.m);
}
