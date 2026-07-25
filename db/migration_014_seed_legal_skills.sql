-- Migration 014: Seed 12 Myanmar corporate-law legal skills
-- Skeletons adapted from anthropics/claude-for-legal (Apache-2.0); all substance
-- re-authored for Myanmar Companies Law 2017 + DICA filing practice and for the
-- Legal Scout agent tools. L1 = name + description (injected into the prompt),
-- L2 = body (loaded on demand via load_skill(name)).
--
-- source values: 'adapted' (skeleton from claude-for-legal), 'native' (authored
-- for Scout), 'manual' (seeded practice profile the admin edits).
-- Idempotent: ON CONFLICT (name) DO NOTHING so re-running never duplicates.

INSERT INTO legal_skills (name, description, body, version, enabled, source) VALUES

-- 1 --------------------------------------------------------------------------
(
  'agm-meeting-chain',
  $desc$Use when the user asks to run an Annual General Meeting, prepare "the AGM documents", call or hold an AGM, or asks what paperwork an AGM needs. Produces the full ordered AGM document chain (notice of calling, notice to shareholders, minutes, shareholders resolution in writing) with a quorum and notice checklist.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# agm-meeting-chain

## Purpose
An Annual General Meeting is not one document, it is a chain of them, and they
have to agree with each other. This skill drafts the whole AGM set in the right
order, from the company data on file, so the notice, the minutes and the written
resolution all name the same shareholders, the same auditor, the same dates.

## When to use
Trigger phrases: "run the AGM", "prepare the AGM documents", "call an AGM",
"annual general meeting for [company]", "AGM minutes", "what do I need for the
AGM". If the user only wants one AGM document, still read this skill so the
single document is consistent with the rest of the set.

## The document chain (draft in this order)
1. **Notice of Calling for Annual General Meeting** — the board's internal call.
2. **Notice of Annual General Meeting to Shareholders** — the notice sent out to
   members with the required notice period.
3. **Annual General Meeting Minutes** — the record of the meeting held.
4. **Shareholders Resolution In Writing for Annual General Meeting** — used where
   the members resolve in writing instead of (or to confirm) the meeting.
These are the four AGM-type templates trained in the system. Confirm the exact
names with `find_matching_templates` before generating — do not hand-type them.

## Workflow (Scout tools)
1. Identify the company. Call `get_company` for the registered name, registration
   number and registered office. The registered office is the meeting location
   default; never put a person's address there.
2. Call `get_directors` and `get_shareholders`. The AGM minutes and the written
   resolution need the individual shareholders and any corporate shareholder by
   name. If a shareholder is a company, its representative is a person who must be
   picked from that company's register (see [[people-register-rules]]), not
   guessed.
3. Confirm the AGM specifics with the user: meeting date, meeting time, financial
   year end being reported on, next financial year end, auditor name and auditor
   fee. If auditor is unknown, leave it as "TBD" — do not invent one.
4. Call `find_matching_templates` for each document in the chain.
5. `prepare_document` then `preview_document` for each, in chain order, so the
   user reviews field fill before anything is finalised.
6. `generate_document` once the user confirms.

## Gates and warnings — quorum and notice checklist
Before drafting the minutes, walk this checklist and surface any gap:
- **Notice period.** The notice to shareholders must give the notice period
  required by the company's constitution and by the Myanmar Companies Law 2017
  (s.85 and following govern AGM requirements — verify the current period and any
  constitutional override; do not assert a day-count you have not confirmed).
- **Quorum.** Confirm the quorum required by the constitution was present. If the
  minutes would record a meeting that was not quorate, stop and flag it — do not
  produce minutes that imply a valid AGM occurred.
- **First AGM / timing.** AGM timing (first AGM and the gap between AGMs) is set
  by the Companies Law 2017 and DICA practice — flag "verify current DICA
  practice" rather than stating a deadline you cannot confirm.
- **Annual return.** After the AGM the company files its annual return with DICA
  (practice: within about two months of the AGM — verify current DICA practice).
  Note this as a follow-up; this skill does not file it.

## Output contract
- Four drafts (or the subset the user asked for), each generated from a trained
  template, each previewed before finalising.
- Every shareholder / director / auditor field filled from company data, with any
  unknown left as an explicit "TBD" — never a fabricated value.
- A short follow-up note listing the DICA annual-return filing and any quorum or
  notice gap flagged above.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 2 --------------------------------------------------------------------------
(
  'director-resolutions',
  $desc$Use when the user asks for a shareholders resolution, a written consent, a members resolution, or asks "who signs" a resolution or consent. Covers the resolution and consent templates, the who-signs matrix from the client signing rules, and a stop-gate for a major one-off action that someone wants signed the same day.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# director-resolutions

## Purpose
Most member and board approvals in these companies happen by resolution in
writing or by consent form rather than a physical meeting. This skill drafts them
in the trained house format and — more importantly — gets the signatories right,
because the wrong signatory on a consent is a defect that surfaces later in DICA
filings and in due diligence.

## When to use
Trigger phrases: "draft a shareholders resolution", "resolution in writing",
"written consent", "members resolution", "who signs this", "consent form for
[person/company]". Also use whenever another skill is about to generate a
resolution or consent and the signatory needs deciding.

## The templates this skill covers
- Shareholders Resolution In Writing — for AGM, and the Director Appointment /
  Director Resignation / Director Resignation and Appointment variants.
- Director Consent Form — Group Member Appointment and Non-Group Member
  Appointment.
- Individual Shareholder Consent Form.
- Corporate Shareholder Consent — Directors Resolution for New Company Setup and
  Director Appointment.
Confirm exact names with `find_matching_templates`; do not hand-type them.

## Who signs — the signing matrix (hard rules)
This is the load-bearing part of the skill. Get it wrong and the document is
worthless.
- **Shareholders resolution in writing** — signed by the company's shareholders
  (members). Pull them with `get_shareholders`.
- **Individual Shareholder Consent Form** — signed by that individual shareholder.
- **Director Consent Form** (group or non-group) — signed by the *incoming
  director* giving consent to act, not by the existing board.
- **Corporate Shareholder Consent** — signed by the CORPORATE SHAREHOLDER'S OWN
  directors, never by the new company's directors. Example: for Arctic Sun, the
  Corporate Shareholder Consent is signed by Pahtama Group's board, because
  Pahtama is the corporate member. Those signatories must be PICKED by the user
  from that shareholder company's register with `lookup_director_candidates` then
  `choose_director` — people are never remembered or guessed. If the shareholder
  company's people are not on file, offer to add them (see
  [[people-register-rules]]) or let the user enter them.

## Workflow (Scout tools)
1. `get_company`, then `get_directors` / `get_shareholders` to establish the
   parties.
2. Classify the action (routine vs major one-off — see the gate below).
3. Decide the signatory using the matrix above. Where the signatory is a
   corporate shareholder's director, ALWAYS resolve them through the picker pair
   `lookup_director_candidates` -> `choose_director`. Never fill a corporate-rep
   signatory from memory.
4. `find_matching_templates`, then `prepare_document` -> `preview_document` ->
   `generate_document`.

## Major action + same-day signature = stop
A resolution or consent for a major one-off action that the user wants signed
TODAY goes to outside counsel first. Both conditions must be true:
1. The action is a major one-off — an M&A step (share transfer or sale, merger,
   acquisition, disposal of the business), a change to the capital structure
   (new shares, buy-back, reduction), taking on financing or security, or a
   dissolution / winding-up; and
2. The ask carries an irreversibility signal — "sign today", "signing this
   afternoon", "need it before the meeting", "send it now".
When both are true, output this and stop:
> Major action plus same-day signature — I will draft it, but I will not mark it
> ready to sign. This is a one-way door and same-day pressure is exactly when a
> defective resolution gets executed. Have your lawyer look at it first. Tell me
> to draft and I will; I will hand you a clearly-marked DRAFT, not a
> ready-to-sign document, until counsel has cleared it.
A routine resolution, or a major action with no same-day-signature ask, follows
the normal flow.

## Output contract
- A draft in house format with the correct signatory block per the matrix.
- For any corporate-shareholder signatory: the picked person(s), shown back to
  the user, sourced from the shareholder company's own register.
- A note of any DICA follow-up the action triggers (e.g. Form C for a director
  change — see [[director-appointment]] / [[director-resignation]]).

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 3 --------------------------------------------------------------------------
(
  'director-appointment',
  $desc$Use when the user wants to appoint a new director, add a director, or bring someone onto the board. Chains the director consent form (group vs non-group), the shareholders resolution and the meeting minutes, applies the picker rules, and notes the DICA Form C filing due within 28 days.$desc$,
  $body$# director-appointment

## Purpose
Appointing a director is a small chain of documents that must line up: the
incoming director consents, the members resolve to appoint, the meeting minutes
record it, and DICA is notified. This skill drives that chain end to end for a
Myanmar company and makes sure the incoming person is identified correctly rather
than guessed.

## When to use
Trigger phrases: "appoint a director", "add a director", "new director for
[company]", "bring [name] onto the board", "director appointment documents".

## The document chain (in order)
1. **Director Consent Form** — the incoming director's consent to act. Choose the
   variant:
   - **Group Member Appointment** — where the incoming director comes from within
     the group (e.g. appointed by/associated with a group member such as the
     holding company).
   - **Non-Group Member Appointment** — an outside appointee.
   If unsure which applies, ask the user; do not default silently.
2. **Shareholders Resolution In Writing - Director Appointment** — the members'
   approval.
3. **Shareholders Meeting Minutes - Director Appointment Only** — the record.
Confirm exact template names with `find_matching_templates`.

## Picker rules (identify the incoming director — never guess)
The incoming director is a person, and people are never remembered or guessed.
1. Ask the user for the appointee.
2. Use `lookup_director_candidates` to search the people register, then
   `choose_director` so the user PICKS from a card. Selection always goes through
   the picker.
3. If the appointee is not on file, offer to add them to the people register
   (full name, nationality, NRC/passport, gender, date of birth, phone, email,
   residential address, and country_of_residence — the consent forms need
   country_of_residence). See [[people-register-rules]].
4. Never map the company's registered-office contact line onto the incoming
   person; a director's own contact details come from the people register only.

## Workflow (Scout tools)
1. `get_company` for the company; `get_directors` to show the current board.
2. Resolve the incoming director through the picker pair above.
3. Pick the consent variant (group vs non-group) with the user.
4. For each document: `find_matching_templates` -> `prepare_document` ->
   `preview_document` -> `generate_document`, in chain order (consent first, then
   resolution, then minutes).

## Gates and warnings
- **Consent before appointment.** The director's consent should be in hand before
  the appointment resolution is treated as effective. If the user wants the
  resolution generated before the consent exists, flag it.
- **DICA Form C — 28 days.** A change of officer (director appointment) is
  notified to DICA on Form C, filed within 28 days of the change (Myanmar
  Companies Law 2017; verify the current DICA form name and window). Add this as
  a follow-up on every appointment. This skill drafts the corporate documents; it
  does not file with DICA.
- **Extract-sourced people.** If the appointee's details came from a DICA extract,
  remember an extract carries name / type / DOB / nationality / NRC-passport /
  gender / appointment date only — never phone, email or residential address. Ask
  the user for those; do not borrow the company's contact line.

## Output contract
- Consent form (correct variant), appointment resolution, and appointment-only
  minutes — each previewed before finalising.
- The picked incoming director shown back to the user with the register fields
  used.
- A Form C follow-up note with the 28-day window flagged for verification.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'native'
),

-- 4 --------------------------------------------------------------------------
(
  'director-resignation',
  $desc$Use when the user wants a director to resign, step down, or leave the board, or wants to replace a director. Chains the resignation letter, the correct resolution and minutes variant (resignation only vs resignation and appointment), soft-ends the person in the register, and notes the DICA Form C filing.$desc$,
  $body$# director-resignation

## Purpose
A director leaving the board produces its own small chain: the resignation
letter, the members' resolution, the minutes, an update to the register, and a
DICA notification. This skill runs that chain and makes sure the outgoing person
is ended in the register correctly rather than deleted.

## When to use
Trigger phrases: "director resignation", "[name] is resigning", "remove a
director", "step down from the board", "replace a director" (resignation plus a
new appointment).

## Choose the variant first
Ask whether this is a resignation only, or a resignation together with a new
appointment — the template set forks here:
- **Resignation only:**
  1. Director Resignation Letter
  2. Shareholders Resolution In Writing - Director Resignation
  3. Shareholders Meeting Minutes - Director Resignation Only
- **Resignation and new appointment:**
  1. Director Resignation Letter (for the outgoing director)
  2. Shareholders Resolution In Writing - Director Resignation and Appointment
  3. Shareholders Meeting Minutes - Director Resignation and New Appointment
  Then follow [[director-appointment]] picker rules for the incoming director,
  including the group vs non-group consent form.
Confirm exact template names with `find_matching_templates`.

## Workflow (Scout tools)
1. `get_company`, then `get_directors` to show the current board.
2. Identify the resigning director from the board list (the user picks which
   sitting director is leaving).
3. If there is also an appointment, resolve the incoming director through
   `lookup_director_candidates` -> `choose_director` (never guessed).
4. Confirm the effective resignation date.
5. Generate the chain: `find_matching_templates` -> `prepare_document` ->
   `preview_document` -> `generate_document`, letter first.

## Register update — soft-end, never delete
When the resignation is finalised, the outgoing director is soft-ended in the
people register (an end/ceased date is recorded), never deleted. History has to
remain reconstructable for future filings and diligence. See
[[people-register-rules]]. Confirm with the user before recording the end date;
this skill flags the update, it does not silently mutate the register.

## Gates and warnings
- **Board floor.** Flag if the resignation would leave the company below the
  minimum number of directors required by the Myanmar Companies Law 2017 or the
  constitution (verify the current minimum). A resignation that breaches the
  minimum needs an appointment at the same time.
- **DICA Form C — 28 days.** A director resignation is an officer change notified
  to DICA on Form C within 28 days (Companies Law 2017; verify current DICA form
  and window). Add as a follow-up.
- **Letter authorship.** The resignation letter is the outgoing director's own
  statement; keep it in that voice and do not add board resolutions into it.

## Output contract
- Resignation letter, the correct resolution variant, and the correct minutes
  variant — previewed before finalising.
- Where an appointment is bundled, the incoming director resolved via the picker
  and the appropriate consent form.
- A register soft-end note and a Form C follow-up note, both flagged for the
  user to confirm / verify.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'native'
),

-- 5 --------------------------------------------------------------------------
(
  'new-company-setup',
  $desc$Use when the user is setting up a new company, incorporating, or asks for the "consent forms for a new company" or the new-company setup pack. Lays out the five-consent-form set, who signs each one, and the prerequisite order for a Myanmar incorporation with individual and corporate shareholders.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# new-company-setup

## Purpose
A new-company setup is a checklist of consents that all have to be signed by the
right people before the incorporation and first appointments hold together. This
skill lays out that set, gets each signatory right, and sequences them so nothing
is signed out of order. It is the incorporation analogue of a closing checklist.

## When to use
Trigger phrases: "set up a new company", "incorporate", "new company setup pack",
"consent forms for a new company", "first directors and shareholders for
[company]", "form a subsidiary".

## The consent set (who signs each — the hard rules)
For a new company with both individual and corporate shareholders and newly
appointed first directors, the set is:
1. **Director Consent Form - Group Member Appointment** — for each incoming
   director drawn from within the group. Signed by that incoming director.
2. **Director Consent Form - Non-Group Member Appointment** — for each incoming
   director from outside the group. Signed by that incoming director.
3. **Individual Shareholder Consent Form** — signed by each individual
   shareholder.
4. **Corporate Shareholder Consent - Directors Resolution for New Company Setup
   and Director Appointment** — signed by the CORPORATE SHAREHOLDER'S OWN
   directors, never by the new company's directors. For Arctic Sun this is
   Pahtama Group's board. Those signatories are PICKED from the corporate
   shareholder's own register (`lookup_director_candidates` -> `choose_director`)
   or entered new — never guessed.
5. **Shareholders Resolution In Writing** as needed to record the members'
   approval of the setup and first appointments.
Confirm exact template names with `find_matching_templates`.

## Prerequisite order
1. Establish the parties first: the new company's proposed name and details, its
   individual shareholders, its corporate shareholder(s), and its first
   directors. Use `get_company` if the shell already exists; otherwise gather
   from the user.
2. Add any people who are not yet on file to the people register, including
   country_of_residence which the consent forms require. See
   [[people-register-rules]].
3. Director consents and shareholder consents are signed BEFORE the appointment
   resolution is treated as effective — consent precedes appointment.
4. The Corporate Shareholder Consent depends on the corporate shareholder's board
   being identified; resolve those signatories through the picker before drafting
   it.
5. Generate each document `prepare_document` -> `preview_document` ->
   `generate_document`.

## Gates and warnings
- **Never cross the signing rule.** The single most common defect: signing the
  Corporate Shareholder Consent with the new company's directors. It is signed by
  the corporate shareholder's directors. Stop and re-check if the signatory you
  are about to use sits on the new company's board rather than the shareholder's.
- **Country of residence.** Both Director Consent Forms need country_of_residence.
  If it is missing for a signatory, ask; do not infer it from nationality.
- **DICA registration.** Incorporation and the first officer details are filed
  with DICA (Companies Law 2017; verify current DICA registration steps and
  forms). This skill produces the corporate consents, not the DICA filing.

## Output contract
- The full consent set, one document per required signer, each with the correct
  signatory.
- Corporate-shareholder signatories shown back to the user, sourced from the
  shareholder company's register.
- A prerequisite / order checklist and a DICA registration follow-up note.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 6 --------------------------------------------------------------------------
(
  'entity-compliance-dica',
  $desc$Use when the user asks about filing deadlines, what is due, annual returns, compliance dates, or registrable changes for a company. Explains how to derive DICA and Companies Law 2017 deadlines from the company data on file (AGM, annual return, officer and registrable changes) — instructions only, data always via get_company.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# entity-compliance-dica

## Purpose
Every registered company carries a rolling set of DICA obligations — hold the
AGM, file the annual return, notify registrable changes on time. This skill
surfaces what is due for a given company by reading its data on file and applying
the Myanmar Companies Law 2017 and current DICA filing practice. It is an
instructions skill: it never invents a company's dates, it computes from
`get_company`.

## When to use
Trigger phrases: "what filings are due", "compliance deadlines", "annual return",
"is [company] up to date", "registrable changes", "DICA deadlines", "when is the
AGM due".

## Data source (always from the record)
Read the company from `get_company` — incorporation date, last AGM date, financial
year end, officers, registered office. Use `get_directors` / `get_shareholders`
for the current officer and member picture. Do not populate any date from memory
or from a generic calendar; if the record does not carry a date you need, say so
and ask the user or flag it for DICA confirmation.

## The compliance anchors (state as playbook items, verify currency)
- **AGM.** The company must hold an AGM per the Companies Law 2017 (s.85 and
  following). First-AGM timing and the maximum gap between AGMs are set by statute
  — phrase these as "verify current DICA practice" rather than asserting a day
  count you cannot confirm from the record or a primary source.
- **Annual return.** The annual return is filed with DICA after the AGM (practice:
  within about two months of the AGM — verify current DICA practice). Compute the
  window from the actual AGM date on file, not a default.
- **Officer changes (Form C).** Appointment or resignation of a director/officer
  is notified to DICA on Form C within 28 days of the change (verify current DICA
  form and window). See [[director-appointment]] / [[director-resignation]].
- **Registrable changes.** Other registrable changes (registered office, share
  changes, constitution amendments, member changes) each have their own DICA
  notification window. Frame these to the user as 30 / 60 / 90-day buckets to
  triage urgency, but tag each specific window "verify current DICA practice"
  unless you have confirmed it. Do not present the buckets as the statutory
  deadlines themselves.

## Workflow (Scout tools)
1. `get_company` (and directors / shareholders) for the subject company.
2. Derive each anchor's next date from the record: AGM from last-AGM + statutory
   gap; annual return from AGM date; any pending officer or registrable change
   from its change date.
3. Present a "what's due" list ordered by urgency (overdue, then due-soon), each
   line naming the obligation, the driving date from the record, and a
   verify-with-DICA tag where the exact window is not confirmed.
4. For anything with no date on file, list it as "unknown — confirm" rather than
   guessing.

## Gates and warnings
- This skill does not file anything with DICA and does not confirm good standing —
  it organises and surfaces obligations from the record.
- Where the record and the user disagree on a date, surface the conflict; do not
  silently prefer either.
- Treat every hard deadline as "verify current DICA practice" unless confirmed —
  DICA practice and forms change.

## Output contract
- A per-company obligation list (AGM, annual return, officer changes, other
  registrable changes) built from `get_company` data, urgency-ordered, with
  verify tags on unconfirmed windows and "unknown — confirm" on missing dates.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 7 --------------------------------------------------------------------------
(
  'dica-extract-intake',
  $desc$Use when the user uploads or asks about a DICA extract, company extract, or officer details pulled from DICA, or asks what fields an extract provides. Explains the anatomy of a DICA extract and the hard rule that an extract never carries a person's phone, email or residential address.$desc$,
  $body$# dica-extract-intake

## Purpose
Company data in this system often originates from a DICA extract. Extracts are
rich but partial, and the single most damaging intake error is carrying the
company's contact line onto a person, or inventing personal contact details an
extract never contained. This skill defines what an extract actually gives you
and what it never does.

## When to use
Trigger phrases: "DICA extract", "company extract", "extract the officers",
"import from DICA", "what does the extract give us", or whenever officer/company
data is being brought in from an extract before documents are drafted.

## Extract anatomy — what an extract carries
For each officer (director/secretary) a DICA extract typically carries:
- Full name
- Type / role (e.g. director)
- Date of birth
- Nationality
- NRC or passport number
- Gender
- Appointment date
For the company it carries the registered name, registration number, registered
office and the registered-office contact line.

## The rule that never bends
An extract NEVER carries a person's phone number, email, or residential address.
- Do not map the company's registered-office phone/email/address onto any officer.
  The contact line in the extract belongs to the company, not to a person.
- When a document needs a person's phone, email, residential address, or
  country_of_residence (the Director Consent Forms and the Individual Shareholder
  Consent Form need these), those fields come from the people register after the
  user supplies them — never from the extract, never from the company contact
  line, never guessed. See [[people-register-rules]].

## Workflow (Scout tools)
1. When officer data arrives from an extract, load it against the company via
   `get_company` and confirm the company-level fields (name, registration number,
   registered office) match.
2. For each officer, keep only the extract-sourced person fields (name, type,
   DOB, nationality, NRC/passport, gender, appointment date). Leave phone, email,
   residential address and country_of_residence empty and flagged as
   "not in extract — ask".
3. If a document downstream needs a missing personal field, prompt the user for
   it explicitly; do not fill it from company data.
4. Use `quick_info` for fast factual confirmation of a single field where needed.

## Gates and warnings
- **Contact-line firewall.** Before writing any person's phone/email/address into
  a document, confirm the value did not come from the company contact line. If it
  did, discard it and ask the user.
- **Appointment date is per person.** Do not reuse one officer's appointment date
  for another.
- **Extract is a lead, not a filing.** An extract reflects DICA at the time it was
  pulled; for current status, verify with DICA.

## Output contract
- A clean intake: company fields confirmed against `get_company`; each officer's
  extract-sourced fields retained; personal contact fields and
  country_of_residence left empty and flagged for the user, never fabricated.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'native'
),

-- 8 --------------------------------------------------------------------------
(
  'people-register-rules',
  $desc$Use when the user works with the people register, adds or edits a person, asks who is on file, sets up a corporate shareholder's representative, or asks how a person's details are stored. Covers the register's fields, the pick-do-not-guess rule, the corporate-rep flow, and the soft-end rule for people who leave.$desc$,
  $body$# people-register-rules

## Purpose
Every signatory and every officer in this system resolves to a person in the
people register. This skill is the rulebook for that register: what it stores,
why people are picked and never guessed, how a corporate shareholder's
representative is handled, and why a person who leaves is ended rather than
deleted.

## When to use
Trigger phrases: "people register", "add a person", "who is on file", "edit
[name]", "set up the representative for [corporate shareholder]", "how are people
stored", or whenever a signatory/officer must be identified.

## The register fields
A person on file carries eight fields:
1. Full name
2. Nationality
3. NRC or passport number
4. Gender
5. Date of birth
6. Phone
7. Email
8. Residential address
Plus **country_of_residence**, which the Director Consent Forms and the
Individual Shareholder Consent Form require. A person can exist without
country_of_residence, but a consent form for them cannot be completed until it is
supplied — prompt for it at consent time.

## Pick, don't guess (the core rule)
People are never remembered or guessed by the agent. Whenever a document needs a
person as signatory or officer:
1. Search with `lookup_director_candidates`.
2. Present the matches and let the user PICK with `choose_director`.
3. Selection ALWAYS goes through the picker card — even when there appears to be
   only one obvious candidate. If no one matches, offer to add a new person with
   the fields above.
This is why the agent must never fabricate a name, an NRC, or a contact detail:
identity is user-confirmed, not inferred.

## Corporate representative flow
A corporate shareholder acts through people — its own directors. When a document
is signed by a corporate shareholder (most importantly the Corporate Shareholder
Consent), the signatories are that company's directors, picked from that
company's register, not the subject company's board. See
[[director-resolutions]] and [[new-company-setup]]. If the corporate
shareholder's people are not on file, add them to the register (same eight
fields, plus country_of_residence) or let the user enter them for this document.

## Soft-end, never delete
When a person leaves — a director resigns, a shareholder exits — they are
soft-ended: an end/ceased date is recorded and they drop out of the active list,
but the record remains for history and future filings. Never hard-delete a person.
See [[director-resignation]].

## Workflow (Scout tools)
1. `lookup_director_candidates` to search; `choose_director` to select.
2. `get_directors` / `get_shareholders` to see who is currently associated with a
   company.
3. When adding, capture all eight fields plus country_of_residence; when a person
   leaves, record the soft-end date rather than deleting.

## Gates and warnings
- **Never carry company contact onto a person** — see [[dica-extract-intake]].
- **Gender is stored but drives no template text** — pronouns resolve through a
  separate pronoun field; do not use gender to guess a pronoun.
- **One person, one record** — reuse the existing register entry rather than
  creating a duplicate for a person who already exists.

## Output contract
- Correct, user-confirmed identification of every person used in a document,
  sourced from the register via the picker, with missing personal fields prompted
  for rather than fabricated, and departures soft-ended.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'native'
),

-- 9 --------------------------------------------------------------------------
(
  'document-review-tabular',
  $desc$Use when the user asks to check documents against each other, verify a set before sending, review for consistency, or asks "do these match". Runs a cross-document consistency check over names, NRC/passport numbers, dates and company fields across a generated set before anything is finalised.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# document-review-tabular

## Purpose
When a chain of documents is generated — an AGM set, an appointment chain, a
new-company consent pack — the failure mode is not a wrong template, it is the
same person, number or date rendered inconsistently across the set. This skill is
a cross-document consistency pass: one row per checked field, one column per
document, every mismatch flagged before the set goes out.

## When to use
Trigger phrases: "check these against each other", "do these documents match",
"review the set before I send", "consistency check", "verify the pack",
"cross-check the AGM documents".

## What to cross-check (the fields that must agree)
- **Company fields** — registered name, registration number, registered office —
  identical across every document. Source of truth: `get_company`.
- **Person names** — every director / shareholder / signatory spelled identically
  and matching the register. Source of truth: the picked register entries.
- **NRC / passport numbers** — identical for the same person across documents.
- **Dates** — meeting date, resolution date, effective date, appointment /
  resignation date, financial year end — internally consistent (e.g. the minutes
  date is not before the notice date; the resolution date is not after the
  effective date).
- **Roles / signatory blocks** — the right signer per [[director-resolutions]]
  (especially: Corporate Shareholder Consent signed by the shareholder's
  directors, not the new company's).

## Workflow (Scout tools)
1. `list_tracked_documents` to enumerate the set under review (filter to the
   company and the recent batch).
2. For each document, read the filled values. Establish the source of truth with
   `get_company`, `get_directors`, `get_shareholders`, and the picked register
   entries.
3. Build a table: rows = checked fields, columns = documents, each cell = the
   value as it appears in that document. Mark any cell that disagrees with the
   source of truth or with the other documents.
4. Every flagged cell is a lead, not a verdict — cite the document and the field
   so the reviewer can open it and fix it.

## The three states of a cell
- **match** — value agrees with the source of truth and the rest of the set.
- **mismatch** — value differs across documents or from the record; flag it.
- **missing** — the field is blank where it should be filled; flag it (a blank is
  information, not a pass).

## Gates and warnings
- **Do not auto-fix.** This skill reports mismatches; correcting them means
  regenerating the affected document through its own skill so the fix is
  consistent everywhere.
- **Signatory mismatches are high severity.** A wrong signer on a consent is worse
  than a typo; surface those first.
- **Every cell is a lead.** Verification against the record is still the
  reviewer's step; this skill makes it fast, it does not replace it.

## Output contract
- A field-by-document table with every cell in match / mismatch / missing state,
  mismatches and missing values listed first with the document and field named,
  and a one-line summary of how many documents were checked and how many issues
  were found.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 10 -------------------------------------------------------------------------
(
  'board-minutes-style',
  $desc$Use when the user asks how to draft or format minutes, what minutes should contain, or how to record attendees, quorum, the chairperson or resolutions. Sets the drafting conventions for meeting minutes — attendee lists, quorum recording, chairperson, and resolution numbering — for Myanmar company minutes.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# board-minutes-style

## Purpose
Minutes are a legal record and they are read later under scrutiny — a DICA query,
a financing, a sale. This skill is the house drafting convention for minutes so
every set reads the same way: how attendees and quorum are recorded, who chairs,
how resolutions are numbered and worded. It shapes the trained minutes templates;
it does not replace them.

## When to use
Trigger phrases: "how should the minutes read", "format the minutes", "what goes
in the minutes", "record attendees / quorum", "resolution numbering", or whenever
a minutes template (AGM minutes, appointment / resignation minutes) is being
filled and needs stylistic consistency.

## Conventions
- **Header block.** Company registered name and registration number, meeting type
  (AGM / directors' / members'), date, and location. Location defaults to the
  registered office from `get_company` — never a person's address.
- **Attendees.** List members / directors present by their register names, then
  those absent, then any others attending (auditor, secretary) separately. Names
  must match the register exactly (see [[people-register-rules]]).
- **Quorum.** Record that quorum was present and, where the constitution sets a
  number, that the number was met. If quorum was not met, the minutes must not
  imply a valid meeting — flag it and stop (see [[agm-meeting-chain]]).
- **Chairperson.** Name who chaired and, where relevant, who acted as secretary /
  minute-taker.
- **Resolutions.** Number resolutions in order and state each as a resolved
  clause. Be specific — name the person appointed or resigning, the auditor and
  fee, the financial year end — a vague "the matter was approved" is a defect in a
  record. Keep the resolution wording consistent with the matching Shareholders
  Resolution In Writing for the same action.
- **Adjournment / date.** Close with the adjournment and the date the minutes bear.

## Workflow (Scout tools)
1. `get_company` for the header fields; `get_directors` / `get_shareholders` for
   attendees.
2. Resolve any named person through the register picker, never by memory.
3. Fill the matching minutes template via `find_matching_templates` ->
   `prepare_document` -> `preview_document`, applying the conventions above.
4. If a companion resolution exists (appointment, resignation, AGM), keep the
   resolution text aligned between the two.

## Gates and warnings
- **No fabricated discussion.** Where discussion content is unknown, leave a clear
  placeholder for the attorney — do not invent what was said.
- **Names and numbers from the record only.** Attendee names, NRC numbers and
  dates come from the register and `get_company`, not from the drafter's memory.
- **Consistency with the set.** Before finalising, consider a pass with
  [[document-review-tabular]] so the minutes agree with the notice and resolution.

## Output contract
- A minutes draft that follows the house conventions — correct header, attendee
  and quorum recording, named chairperson, numbered and specific resolutions —
  filled from the record and previewed before finalising.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 11 -------------------------------------------------------------------------
(
  'cold-start-interview',
  $desc$Use when the user wants to set up the practice profile, tell the agent about their firm, "onboard me", or asks how to teach the agent their conventions. Runs a short chat interview (ten questions or fewer) and tells the admin to paste the findings into the editable practice-profile skill.$desc$,
  $body$<!-- Adapted from anthropics/claude-for-legal (Apache-2.0) -->
# cold-start-interview

## Purpose
The agent gives better output when it knows the firm's context — the group it
acts for, its signing conventions, how it escalates. This skill runs a short
interview to capture that once, then hands the answers to the admin to save into
the editable [[practice-profile]] skill, which every other skill can then read.

## When to use
Trigger phrases: "set up the practice profile", "onboard me", "tell you about our
firm", "configure the agent for us", "teach you our conventions", or on first use
when the practice profile still reads as the seeded default.

## How it runs (a short chat interview — ten questions or fewer)
Ask in small batches, two or three at a time, and wait for answers. Keep the
whole interview to ten questions or fewer. Cover:
1. **Group context.** Which group and companies do you act for? Which is the
   holding company, and which companies are its members / subsidiaries?
2. **Corporate shareholders.** For companies with a corporate shareholder, which
   company is it, and whose board signs its consents?
3. **Signing conventions.** Any house rules on who signs what beyond the standard
   matrix (see [[director-resolutions]]).
4. **Escalation.** When does a matter leave the agent and go to outside counsel?
   (Default: major one-off actions — M&A, capital structure, dissolution.)
5. **House format notes.** Any conventions for minutes and resolutions —
   numbering, wording, financial year end defaults.
6. **DICA practice.** Any firm-specific notes on DICA filing windows or forms to
   apply (still verify currency).

## Handing off to the admin (this skill does not write config)
This skill gathers; it does not silently write the practice profile. When the
interview is done, summarise the findings and tell the admin exactly where to put
them:
> Here is your practice profile summary. To save it, open Overview -> Skills, edit
> the "practice-profile" skill, and paste this in under the matching headings.
> Every skill reads it from there.
Present the summary already structured under the [[practice-profile]] headings
(Group context, Signing conventions, Escalation, House format notes) so it can be
pasted straight in.

## Gates and warnings
- **Do not invent facts.** If the user skips a question, leave that heading marked
  "not set" rather than filling it with a plausible guess.
- **Verify legal facts as they come up.** If the user states a DICA window or a
  statutory number, tag it "verify current DICA practice" before it goes into the
  profile — a wrong fact in the profile propagates into every output.
- **The user's typed answers are the only input.** Do not fold in unrelated
  context or prior sessions.

## Output contract
- A structured practice-profile summary (ten questions or fewer answered), grouped
  under the [[practice-profile]] headings, with explicit instructions to the admin
  to paste it into the editable practice-profile skill via Overview -> Skills.

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'adapted'
),

-- 12 -------------------------------------------------------------------------
(
  'practice-profile',
  $desc$Read by other skills for firm context, and edited by the admin to configure the agent. Holds the seeded CHL practice profile — the group and its companies, signing conventions, escalation rule and house format notes. Edit this skill (Overview then Skills) to tune how the agent works. Runs the cold-start interview to populate it.$desc$,
  $body$# practice-profile

<!-- EDIT ME. This is the CHL practice profile the other skills read for firm
context. It ships with a minimal seed below. To change how the agent works, edit
this skill in the admin (Overview -> Skills), or run [[cold-start-interview]] and
paste its summary in under the matching headings. Everything below the seed line
is safe to replace. -->

## Purpose
This skill is configuration, not a workflow. Other skills read it to know the
firm's context — which group it acts for, who signs what, when to escalate, and
the house format. It is seeded minimally and is meant to be edited.

## When to use
Skills load this for context whenever firm-specific conventions matter. A human
edits it directly (Overview -> Skills) or via [[cold-start-interview]].

## -------- SEED (edit below this line) --------

## Group context
- Acts for the City Holdings group of companies.
- Group members include ARCTIC SUN COMPANY LIMITED.
- The holding member for Arctic Sun is PAHTAMA GROUP COMPANY LIMITED (the
  corporate shareholder whose board signs Arctic Sun's Corporate Shareholder
  Consent).
- Add the remaining group companies and their holding relationships here as they
  are confirmed.

## Signing conventions (summary — full rules in [[director-resolutions]])
- Shareholders resolutions in writing: signed by the company's members.
- Individual Shareholder Consent Form: signed by that individual.
- Director Consent Form: signed by the incoming director.
- Corporate Shareholder Consent: signed by the CORPORATE SHAREHOLDER'S OWN
  directors, picked from that shareholder company's register — never the new
  company's directors, never guessed.

## Escalation
- Major one-off actions go to outside counsel: M&A steps (share sale/transfer,
  merger, acquisition, disposal), capital-structure changes (new shares,
  buy-back, reduction), financing/security, and dissolution/winding-up.
- Everything routine (AGM sets, director appointments/resignations, standard
  consents) is handled in-agent with attorney review of the drafts.
- Anything asked to be "signed today" that is also a major action stops for
  counsel (see [[director-resolutions]]).

## House format notes
- Location on minutes/notices defaults to the company registered office from the
  record, never a person's address.
- Financial year end default is 31 December unless the record says otherwise.
- Auditor name / fee left as "TBD" when unknown, never invented.
- People are identified through the picker and the people register only
  (see [[people-register-rules]]); departures are soft-ended, never deleted.
- Treat DICA filing windows (annual return, Form C 28 days, other registrable
  changes) as "verify current DICA practice" unless confirmed.

## -------- END SEED --------

Every output is a draft for attorney review — not legal advice.$body$,
  '1.0.0', TRUE, 'manual'
)

ON CONFLICT (name) DO NOTHING;
