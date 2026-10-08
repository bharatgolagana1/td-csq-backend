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
