/**
 * Indian states and union territories → ACFI/AAI-style region. Used when an
 * airport row arrives without a region (CSV import, vendored seed file).
 */
export const REGIONS = ['North', 'South', 'East', 'West', 'North-East'] as const;
export type Region = (typeof REGIONS)[number];

const STATE_REGION: Record<string, Region> = {
  'Andaman and Nicobar Islands': 'East',
  'Andhra Pradesh': 'South',
  'Arunachal Pradesh': 'North-East',
  Assam: 'North-East',
  Bihar: 'East',
  Chandigarh: 'North',
  Chhattisgarh: 'West',
  'Dadra and Nagar Haveli and Daman and Diu': 'West',
  Delhi: 'North',
  Goa: 'West',
  Gujarat: 'West',
  Haryana: 'North',
  'Himachal Pradesh': 'North',
  'Jammu and Kashmir': 'North',
  Jharkhand: 'East',
  Karnataka: 'South',
  Kerala: 'South',
  Ladakh: 'North',
  Lakshadweep: 'South',
  'Madhya Pradesh': 'West',
  Maharashtra: 'West',
  Manipur: 'North-East',
  Meghalaya: 'North-East',
  Mizoram: 'North-East',
  Nagaland: 'North-East',
  Odisha: 'East',
  Puducherry: 'South',
  Punjab: 'North',
  Rajasthan: 'North',
  Sikkim: 'North-East',
  'Tamil Nadu': 'South',
  Telangana: 'South',
  Tripura: 'North-East',
  'Uttar Pradesh': 'North',
  Uttarakhand: 'North',
  'West Bengal': 'East',
};

export function regionForState(state: string): Region | null {
  return STATE_REGION[state.trim()] ?? null;
}

/** ISO 3166-2:IN subdivision codes as OurAirports writes them (note IN-MM for Maharashtra, IN-OR for Odisha). */
export const ISO_STATE: Record<string, string> = {
  'IN-AN': 'Andaman and Nicobar Islands',
  'IN-AP': 'Andhra Pradesh',
  'IN-AR': 'Arunachal Pradesh',
  'IN-AS': 'Assam',
  'IN-BR': 'Bihar',
  'IN-CH': 'Chandigarh',
  'IN-CT': 'Chhattisgarh',
  'IN-DH': 'Dadra and Nagar Haveli and Daman and Diu',
  'IN-DL': 'Delhi',
  'IN-GA': 'Goa',
  'IN-GJ': 'Gujarat',
  'IN-HR': 'Haryana',
  'IN-HP': 'Himachal Pradesh',
  'IN-JK': 'Jammu and Kashmir',
  'IN-JH': 'Jharkhand',
  'IN-KA': 'Karnataka',
  'IN-KL': 'Kerala',
  'IN-LA': 'Ladakh',
  'IN-LD': 'Lakshadweep',
  'IN-MP': 'Madhya Pradesh',
  'IN-MH': 'Maharashtra',
  'IN-MM': 'Maharashtra',
  'IN-MN': 'Manipur',
  'IN-ML': 'Meghalaya',
  'IN-MZ': 'Mizoram',
  'IN-NL': 'Nagaland',
  'IN-OR': 'Odisha',
  'IN-PY': 'Puducherry',
  'IN-PB': 'Punjab',
  'IN-RJ': 'Rajasthan',
  'IN-SK': 'Sikkim',
  'IN-TN': 'Tamil Nadu',
  'IN-TG': 'Telangana',
  'IN-TR': 'Tripura',
  'IN-UP': 'Uttar Pradesh',
  'IN-UT': 'Uttarakhand',
  'IN-WB': 'West Bengal',
};

/** The 14 Phase-I airports (REQUIREMENTS / DEMO-PLAN); the seed marks them active. */
export const PHASE_I_IATA = ['DEL', 'BOM', 'BLR', 'HYD', 'MAA', 'CCU', 'COK', 'AMD', 'GOI', 'TRV', 'PNQ', 'JAI', 'LKO', 'NAG'] as const;
