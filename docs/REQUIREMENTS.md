# CSQ – Project Requirements

Source: product owner's requirements document, 7 Oct 2026. Supplemented by
the ACFI pitch deck (23 parameters across four heads: Infrastructure /
Facilities, Security / Safety, Processes, Trade Facilitation; scale Excellent,
Very Good, Good, Fair, Poor + NA; results confidential per operator) and the
2017–2021 product documents (vocabulary, flows). Where this document says
"1 – Very Poor … 5 – Excellent" the labels used in the product are ACFI's:
Poor (1), Fair (2), Good (3), Very Good (4), Excellent (5), NA.

## 1. Project Overview

The CSQ platform will manage **Domestic and International Cargo Service Quality Survey Assessments** across airports.

The system will support multiple stakeholder categories participating in the cargo ecosystem. The overall stakeholder types are:

- Shippers
- Consignees
- Airports
- ACO – Airport Cargo Operators
- FF – Freight Forwarders
- CB – Customs Brokers

For the current phase, the platform will primarily support:

- **ACO – Airport Cargo Operators**
- **FF – Freight Forwarders**
- **CB – Customs Brokers**

The platform will be centrally administered by the **CSQ Super Admin**.

## 2. User Roles

### 2.1 Super Admin

The Super Admin will have complete control over the CSQ platform:

- Create and manage Airports
- Onboard CTOs / Cargo Terminal Operators
- Onboard ACOs
- Manage stakeholder organizations
- Configure Domestic and International survey forms
- Configure question categories and subcategories
- Create and manage Assessment Cycles
- Define sampling rules
- Define minimum sample size
- Configure notification and reminder schedules
- Monitor assessment participation
- View assessment results
- Calculate airport-level scores
- Apply market-share-based weightage
- Generate reports and analytics

## 3. Airport Structure

An **Airport** is one of the primary entities. Each airport may have multiple
CTOs / Cargo Terminal Operators, multiple ACOs, multiple Freight Forwarders
and multiple Customs Brokers. An ACO must always be associated with an
Airport. Each ACO may have a different market share at the airport; the
market share is used when calculating the final weighted CSQ score for that
Airport.

## 4. CTO / Operator Onboarding

Super Admin can onboard multiple CTOs, each tagged to a specific Airport. Two
methods:

- **Admin onboarding** – Super Admin creates the organisation directly.
- **Self-onboarding** – Super Admin generates a unique onboarding link; the
  organisation completes the registration form; Super Admin reviews and
  approves.

## 5. ACO Onboarding

Same two methods. Registration information may include: Organization Name,
Airport, Contact Person, Email, Mobile Number, Address, Domestic /
International operations, Market Share, other organisation details. Once
approved, the ACO administrator receives access to the platform.

## 6. ACO Dashboard

After logging in, an ACO has its own dashboard and manages its participating
stakeholders (FF and CB): add members individually, bulk import, edit,
deactivate, categorise, search and filter, view previous assessment
participation.

## 7. FF / CB Member Information

Name / Organization Name, Contact Person, Email Address, Phone Number,
Stakeholder Type (Freight Forwarder | Customs Broker), Survey Type (Domestic |
International | Both), Associated Airport, Associated ACO, Active / Inactive
status. Bulk import via an Excel/CSV template.

## 8. Domestic and International Surveys

Separate survey configurations for Domestic and International cargo
operations. The system identifies which questionnaire to send based on the
participant's classification.

## 9. Survey Question Structure

Survey → Category → Subcategory → Question.
Example: Category "Cargo Handling" → Subcategory "Shipment Acceptance" →
Question "How would you rate the efficiency of the cargo acceptance process?"

## 10. Question Response Format

Rating 1–5 (Poor … Excellent), plus **Not Applicable (N/A)** and
**Comments** (optional or mandatory per question). Question configuration:
Mandatory / Optional, Domestic / International, applicable stakeholder type,
Category, Subcategory, order, Active / Inactive.

## 11. Assessment Cycle

Super Admin configures: Assessment Name, Assessment Type (Domestic |
International | Both), Assessment Start/End Date, Sampling Start/End Date,
Minimum Sampling Size, number of Sampling Reminders, number of Assessment
Reminders, reminder frequency/schedule, Participating Airports, Participating
ACOs.

## 12. Phase 1: Sampling

On publish, all applicable ACOs are notified with the assessment name, the
sampling and assessment windows and the minimum required sample size. The ACO
selects participants from existing or newly added FF/CB.

## 13. Sample Selection

During the sampling period the ACO can view its complete FF/CB database,
filter Domestic/International, select participants, add new participants,
see the minimum requirement and the selected count (e.g. **Selected: 43 /
50**). The system prevents locking until the minimum has been reached.

## 14. Sample Locking

After locking, the participant list is part of the cycle and cannot normally
be modified; modification requires Super Admin permission or an authorised
unlock action, with an audit trail of lock/unlock actions.

## 15. Assessment Activation

At **midnight on the Assessment Start Date** the system activates the
assessment for all locked participants. Every participant receives a secure
notification: assessment name, airport, ACO, start/end dates, secure login
link, temporary password / OTP-based access. No complicated registration.

## 16. Participant Authentication

Login link + temporary password, or OTP / passwordless. Each invitation can
only be used by the intended participant.

## 17. Assessment Experience

The questionnaire shows Category, Subcategory, Question, 1–5 rating, Not
Applicable, Comments. The participant can save progress, continue later,
navigate between sections, see completion percentage (e.g. **68 %**), review
before submission and submit. Submitted responses are locked.

## 18. Assessment Reminders

Automatic reminders to participants who have not completed, with configurable
count, interval and channels (Email, SMS, WhatsApp, in-app). Reminders stop
on submission.

## 19. Sampling Reminders

Reminders to ACOs during the sampling period, e.g. "Sampling closes in 3
days. Minimum required participants: 50. Currently selected: 37." — until
the sample is locked.

## 20. Market Share Weightage

The Airport CSQ score is the market-share weighted mean of its ACOs' scores,
e.g. (4.5 × 50 %) + (4.0 × 30 %) + (3.5 × 20 %) = **4.15**, at question,
subcategory, category and overall level.

## 21. Market Share Configuration

Configurable per **Airport + ACO + Assessment Period**; historical cycles
preserve the values applicable at the time; frozen once the assessment
begins.

## 22. Scoring and N/A Handling

N/A neither reduces nor inflates a score: 5, 4, N/A, 3 → (5 + 4 + 3) / 3.
Formula details and minimum-response thresholds are configurable.

## 23. Reporting Hierarchy

Overall (National, Airport) · Airport (→ ACO, → Domestic, → International) ·
ACO (overall, category, subcategory, question) · Stakeholder (FF responses,
CB responses). Comparison between Assessment Cycles.

## 24. Assessment Monitoring Dashboard (Super Admin)

Sampling: Airports, ACOs, Sample Required, Sample Locked. Assessment: Invites
Sent, Started, Completed, Pending, Completion Rate. Drill-down Airport → ACO
→ Participant.

## 25. ACO Assessment Dashboard

Only its own organisation: current cycle, sampling deadline, minimum sample
size, selected, locked, invitations sent, started, completed, pending,
reminder status.

## 26. Audit Trail

User, Organization, Action, Date and Time, Previous Value, New Value, IP /
session. Examples: participant added/removed, sample locked/unlocked, market
share modified, assessment created/published, survey submitted.

## 27. High-Level Workflow

Super Admin configures airports, onboards operators, configures surveys,
creates the cycle (sampling dates, assessment dates, minimum sample,
reminders) and publishes → ACO receives notification, reviews its FF/CB
database, imports/adds participants, selects the sample, locks → System
waits for the assessment start date, activates at midnight, creates
participant access, sends links → FF/CB log in, rate 1–5 / N/A, comment,
submit → System sends reminders, calculates scores, applies market-share
weightage → Super Admin monitors completion, reviews scores, compares
cycles, generates reports.

## 28. Core Data Relationships

Airport → many ACOs. ACO → one Airport, many FF, many CB. Assessment Cycle →
many Airports, many ACOs, sampling configuration, assessment configuration,
market-share snapshot, participant samples. Survey → Domestic /
International → Categories → Subcategories → Questions. Participant (FF/CB)
→ belongs to ACO and Airport; may participate in multiple cycles.
Assessment Response → Participant, Cycle, Question, Rating / N/A, Comments.

## 29. Important Design Principle

Keep three concepts separate: **Stakeholder master data** (who the FFs, CBs,
ACOs and Airports are), **Sampling** (who was selected for a specific cycle),
**Assessment** (what those participants submitted). The same FF or CB
participates in multiple cycles without being recreated.
