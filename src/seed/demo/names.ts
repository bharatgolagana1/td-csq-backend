// Fictional name and text pools for the demo dataset. Every company and
// person here is invented; e-mail addresses live under example.in.

export const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Arjun', 'Asha', 'Deepa', 'Devika', 'Farhan', 'Gaurav', 'Harish', 'Ishaan',
  'Kavitha', 'Kiran', 'Lakshmi', 'Manish', 'Meera', 'Mohit', 'Nandini', 'Neha', 'Nikhil', 'Pooja',
  'Pranav', 'Priya', 'Rahul', 'Rajesh', 'Ravi', 'Rohan', 'Sameer', 'Sanjay', 'Shreya', 'Siddharth',
  'Sunita', 'Suresh', 'Tanvi', 'Thomas', 'Varun', 'Vikram', 'Vinod', 'Zara',
] as const;

export const LAST_NAMES = [
  'Agarwal', 'Banerjee', 'Bhat', 'Chandran', 'Chopra', 'Das', 'Desai', 'Fernandes', 'Gupta', 'Iyer',
  'Jain', 'Joshi', 'Kapoor', 'Khan', 'Kulkarni', 'Mehta', 'Menon', 'Mishra', 'Naik', 'Nair',
  'Pillai', 'Rao', 'Reddy', 'Saxena', 'Sethi', 'Shah', 'Sharma', 'Singh', 'Varghese', 'Verma',
] as const;

/** Freight forwarder company names: prefix + (optional middle) + suffix. */
export const FF_PREFIX = [
  'Apex', 'Bluewave', 'Bharat', 'Cosmos', 'Eagle', 'Falcon', 'Global', 'Horizon', 'Indo', 'Jai',
  'Krishna', 'Lotus', 'Meridian', 'Monsoon', 'Nalanda', 'Om', 'Orbit', 'Peninsula', 'Prime', 'Royal',
  'Sagar', 'Sai', 'Shree', 'Silk Route', 'Skyline', 'Summit', 'Sunrise', 'Swift', 'Trans', 'Trident',
  'United', 'Vayu', 'Zenith',
] as const;

export const FF_SUFFIX = [
  'Air Cargo', 'Air Freight', 'Cargo Movers', 'Carriers', 'Express', 'Forwarders', 'Freight Lines',
  'Freight Services', 'Logistics', 'Shipping', 'Worldwide Logistics',
] as const;

export const CB_PREFIX = [
  'Ashoka', 'Capital', 'Coastal', 'Deccan', 'Ganga', 'Gateway', 'Harbour', 'Himalaya', 'Konkan',
  'Malabar', 'Mysore', 'Narmada', 'National', 'Pioneer', 'Rajputana', 'Reliable', 'Saraswati',
  'Sindhu', 'Southern', 'Tricolour', 'Vindhya', 'Western',
] as const;

export const CB_SUFFIX = [
  'Clearing Agency', 'Customs Brokers', 'Customs House Agents', 'Clearing & Forwarding', 'Trade Services',
] as const;

export const CUSTOMER_TAGS = ['perishables', 'pharma', 'express', 'e-commerce', 'engineering', 'garments', 'dangerous goods', 'project cargo'] as const;

/** Why a question was rated Fair or Poor, per survey head. */
export const LOW_RATING_COMMENTS: Readonly<Record<string, readonly string[]>> = {
  INFRA: [
    'Not enough space in the import shed during the peak season',
    'Forklifts and trolleys are often unavailable at the truck dock',
    'Weighing scales were out of order twice this quarter',
    'Long queue at the delivery counter in the evenings',
    'Cold room capacity is too small for pharma consignments',
  ],
  SEC: [
    'Screening queue takes over an hour on most mornings',
    'Entry passes for drivers take too long to issue',
    'Signage for dangerous goods storage is missing',
    'Security staff were short-handed on weekends',
  ],
  PROC: [
    'The terminal system was down and we had to file manually',
    'Slot booking is not followed at the gate',
    'Documentation counter understaffed during peak hours',
    'Procedures changed without notice to the trade',
  ],
  TRADE: [
    'No response to our grievance filed last month',
    'The bank counter closes before the evening rush',
    'Damage incidents are not investigated properly',
    'Helpdesk staff could not answer basic queries',
  ],
};

export const GENERIC_LOW_COMMENTS: readonly string[] = ['Service was slow and inconsistent', 'Needs improvement; repeated delays this cycle'];

export const POSITIVE_COMMENTS: readonly string[] = [
  'Staff were helpful and the process was smooth',
  'Noticeable improvement over the last cycle',
  'Quick turnaround on our perishable consignments',
  'Clear communication at every step',
  'Good coordination between the terminal and customs',
];

export const SELF_COMMENTS: readonly string[] = [
  'Additional staff deployed in the peak window',
  'Upgrade planned for the next quarter',
  'Monitoring in place; improvement expected next cycle',
];

/** How a customer sums up a survey head before submitting (one remark per section). */
export const SECTION_REMARKS: Readonly<Record<string, readonly string[]>> = {
  INFRA: [
    'Shed space and handling equipment are adequate on most days; the peak season is the pressure point',
    'Better than last cycle, but the truck dock still gets congested in the evenings',
    'Cold room and weighing work well; more covered parking for trucks would help',
  ],
  SEC: [
    'Screening is thorough; the morning queue is the main delay',
    'Security staff are courteous; driver passes could be issued faster',
    'Procedures are clear and followed consistently',
  ],
  PROC: [
    'Documentation and gate processes are generally smooth',
    'System downtime meant manual filing a few times this cycle',
    'Slot booking works when followed; enforcement at the gate is uneven',
  ],
  TRADE: [
    'The helpdesk is responsive; grievance follow-up could be quicker',
    'Good facilitation overall; the bank counter closes too early for evening shipments',
    'Communication with the trade has improved this cycle',
  ],
};

export const GENERIC_SECTION_REMARKS: readonly string[] = ['Satisfactory overall this cycle', 'Generally good, with room for improvement at peak hours'];

/** The operator's own summary of each head: what it is doing about it. */
export const SELF_SECTION_REMARKS: Readonly<Record<string, readonly string[]>> = {
  INFRA: ['Shed expansion and two new forklifts planned for the next quarter', 'Cold chain capacity reviewed; additional racks installed'],
  SEC: ['Extra screening lane opened in the morning peak', 'Driver passes moved online to cut waiting time'],
  PROC: ['Terminal system upgrade scheduled to reduce downtime', 'Documentation counter staffed up in peak hours'],
  TRADE: ['Grievance desk now tracks every complaint to closure', 'Monthly meetings started with forwarders and brokers'],
};

export const GENERIC_SELF_SECTION_REMARKS: readonly string[] = ['Improvement plan in place for this head'];
