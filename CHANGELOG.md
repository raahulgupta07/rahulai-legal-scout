# Changelog

All notable changes to Legal Scout.

## [1.2.70] — 2026-08-27

### Fixed — one form, one card

`ask_questions` was capped at 4 questions. The documents need more.

Measured in a real browser on the live box, Director Consent Form (Non-Group)
for CITY MART HOLDING: the panel listed FIVE outstanding fields — date, address,
country of residence, phone, email — and the card asked four. **`email` was
never put to the user.** The answers came back one short, `generate_document`
refused it as an undeclared blank, and the run needed a second card to ask a
single question.

It worked, because the stall guard shipped earlier the same day absorbs the
extra round. It should not have to: the form is one form, and the person filling
it should see all of it.

- `MAX_QUESTIONS = 8`. Eight rather than "no limit" — a cap still has to exist
  so a runaway call cannot put thirty boxes on screen, and the largest free-text
  load measured across the 15 templates is six.

- The number lived in THREE places: the validator, the tool docstring and the
  system prompt. The last two are prose the model reads, and they cannot
  interpolate a constant — a prompt still reading "1-4" would cap the card at
  four however high the validator allowed. `U38` pins all three to the constant,
  and the prompt now also says to ask for every outstanding field in one card.

- **Raising the cap alone did not fix it.** Verified in the browser: with room
  for eight the model asked four and MERGED phone and email into one box under
  the invented id `contact_info`. That id matches no placeholder, so the answer
  reached neither field, both stayed blank, and the second round happened
  anyway. The schema had only ever called `id` a "stable key you will read the
  answer back by" — nothing tied it to the field it answers.

  The `id` must now BE the field name, one field per question, said in all three
  places the model reads: the schema, the tool docstring, and the
  needs-input instruction that names the missing fields. Re-verified in the
  browser afterwards — five separate questions with ids `date`, `address`,
  `country_of_residence`, `phone`, `email`, every one of them a real placeholder
  in that template.

The frontend needed no change: it renders whatever it is given and already
counts "Question N of M".

### Notes

`U38h` is the case worth keeping. Mutation-tested by raising the validator while
leaving the prompt at 1-4 — the suite goes red naming exactly that, which is the
failure that would otherwise look like the fix working while nothing changed on
screen.

Also corrected today, from an earlier claim in this session: an untrained
template stringifying a party dict into a document is real but NARROWER than
reported. It needs a mapping-less template AND a dict in the data; dicts only
arrive through the picker path, which requires a mapping. Verified all three
combinations. Left unfixed deliberately — it is not reachable through the
product, and a guard would be code for a case that cannot happen yet.

## [1.2.69] — 2026-08-27

### Fixed — a pick changes the answer, so the panel now moves with it

Found by testing 1.2.68 in a real browser rather than through the API. Session
`9c586813`: after choosing KYAW THU SOE the panel still read **3/11** with
NATIONALITY, NRIC and DATE OF BIRTH pending — while the question card beside it
correctly did **not** ask for any of the three, because the resolver had all
three from the register.

The run was `choose_director` then `ask_questions`. No document tool ran after
the pick, so no fresh `document_state` was ever emitted and the panel kept
showing what `preview_doc` had computed BEFORE anyone was chosen. Honest about
what it last knew, and wrong about what is true — and what a lawyer reads there
is "these fields are still missing".

- **The picker declares the new state itself.** A pick is exactly the event that
  changes the answer, so it no longer waits for the next document tool.
  `recall_task` already holds the template and company for the conversation,
  which is what makes this a lookup rather than a guess. Wrapped whole: a panel
  refresh must never be able to fail a selection, and an uncomputed state is
  omitted rather than sent empty — leaving the previous numbers beats blanking
  them.

- **The panel folds any result that DECLARES a state**, whatever the tool is
  called. Admitting pickers by NAME would mean listing every one and re-listing
  them whenever another is added — the exact drift that left `preview_doc` out
  of `DOC_TOOLS` for weeks. Admission by evidence cannot drift, and a result
  without a state is still ignored, so the inference fallback never sees a
  picker payload it would misread.

Verified in the browser on the same flow: the pick takes the panel from
**3/11 to 6/11**, Outstanding 8 → 5, with `Myanmar`, `12/LAMANA(N)142591` and
`1987-09-21` moving into Resolved. Panel and question card now agree.

### Notes

The API tests that "verified" 1.2.68 were blind to the fix they were checking.
The stall is a MODEL behaviour and the recovery is in the browser, so an API
client always sees the stall and never sees the guard. The real browser run is
what proved it: same request that previously took three runs and two typed
"continue"s completed with nothing typed but the request. Worth remembering
before trusting an API-level pass on anything client-side.

`U37f` failed against correct code on its first run — the header comment above
`declaresState` names `choose_director` while explaining why picker names must
NOT be listed, and the scan matched that explanation. That is the THIRD source
check today to read its own documentation (`U36b` and this one after `U32e`).
Comments are stripped before the scan now, and that should be the default shape
for any of these.

## [1.2.68] — 2026-08-27

### Fixed — three defects found by scanning every template, not the one in front of us

**An NRC field printed the director's name.** On *Corporate Shareholder Consent —
Directors Resolution*, `appointed_director_1_nrc` / `_2` / `_3` are TRAINED as
person-NAME slots (`source=slot`, `kind=new_director`), so the slot branch
rendered the name into an identifier field. Measured before the fix, all three:

    appointed_director_1_nrc  ->  KYAW THU SOE
    appointed_director_2_nrc  ->  MIN MIN
    appointed_director_3_nrc  ->  WIN WIN TINT

A consent form stating "N.R.C./Passport: KYAW THU SOE" is filled, confident and
wrong — strictly worse than a blank, which a reader would catch. An identifier
placeholder now resolves to the party's identifier, or asks. After: the three
fields return `12/LAMANA(N)142591`, `12/LATHANA(N)016603`, `12/LATHANA(N)001520`.

**A single-signatory form asked for what the register held.** The *Individual
Shareholder Consent Form* has one person, but its slot is typed
`shareholder_list`, and the sole-person rule excluded every list-kind slot
regardless of `multi`. All four of its attributes were asked. Now a list slot
holding ONE person names the bare role, so nationality, NRC and date of birth
resolve and only `address` is asked — the register genuinely has no address for
anyone.

**A company's address was read as somebody's home address.** `company_address`
classified as `("company", "residential_address")`. Harmless while it fell
through to a question; one slot name away from writing a director's home address
into a company field. Roles that name an entity are now excluded by word, not by
substring — `corporate_shareholder_1_nrc` still resolves through the person path,
because that is where the picker's answer for that position lives.

Coverage across all 15 templates: **23 of 31 person-attribute placeholders
resolved, now 30 of 30** (the 31st was `company_address`, correctly no longer
counted as one).

### Fixed — a turn that ends OWING a tool call is a stall, however well it reads

Session `75400f45-49c5-4fb1-aa1b-d97a555ee6cd`: one request took THREE runs,
because the model twice ended a turn without making the call its own tool result
demanded, and the user typed "continue" by hand each time.

    run 1  COMPLETED  lookup_director_candidates  ->  never called choose_director
    run 2  COMPLETED  generate_document (blank fields)  ->  never called ask_questions
    run 3  PAUSED     ask_questions   <- finally asked

The existing guard fired only on `chunk.content.trim() === ''`. Both stalls ended
with a confident "Preview Summary" paragraph, so it never ran. Ending with
polished prose is worse than ending silently: it looks finished, so nobody can
tell the turn stalled.

`findUnpaidToolDebt` reads the debt STRUCTURALLY out of the tool results — a
lookup result names the picker it owes, a failed generate names its blank or
required fields — never out of the English `agent_instruction` strings, which are
reworded whenever the prompts are tuned. A paused run owes nothing: the card is
already on screen.

It feeds the SAME recovery as the empty-turn guard, sharing the per-run guard and
`MAX_CONSECUTIVE_NUDGES`. The bound is load-bearing in a way worth naming: the
measured stall ends with real prose, so without `&& !toolDebt` on the counter
reset the budget would refill on every stalled turn and the nudge would be
unbounded — which is how the same document once got generated three times.

### Notes

Two person slots still ASK for a bare attribute, deliberately: guessing would
print one person's details beside the other's name. A runtime net covers the
case the template shape cannot — one list slot with TWO people actually chosen
also asks. Mutation-tested: removing it turns `U35k` red with the first party's
NRC standing in for both.

Three of this release's own guards failed their first run and were rewritten
rather than the product bent to fit them:

- `U35d` demanded that `corporate_shareholder_address` be classified non-person.
  A corporate shareholder is a party, so the role reads person-shaped; what
  matters is that nothing from a person's row can reach it, and nothing does.
  Re-asserted as behaviour instead of classification.
- `U36b` scanned `toolDebt.ts` for `agent_instruction` — and matched the header
  comment explaining why that string must never be used. Comments are stripped
  before the scan now. A source check that reads its own documentation measures
  nothing.
- `U11l` counted `!closeFromTool &&` occurrences and went stale when both
  branches were refactored to share one `shouldNudge` const carrying the guard
  once. The intent is unchanged; the case now accepts either shape.

## [1.2.67] — 2026-08-27

### Fixed — the panel was watching tool names that never stream

The document panel read "No document yet" beside a chat holding that document's
template, company, director and NRC. Nothing had failed: the run called
`preview_doc`, which returns a full `document_state`, and the panel's
`DOC_TOOLS` set listed **`preview_document`**.

`_as_json` wraps with `functools.wraps`, so agno registers a tool under the
FUNCTION name, not the key `create_smart_document_tool` exports it under. The
export map says `preview_document`; the stream says `preview_doc`. agent.py:213
documents this exactly — and the PROMPT was corrected for it when it was found.
Three frontend files were not, and stayed wrong:

- `useArtifact.ts` filtered every `preview_doc` result out of the fold, so the
  panel never saw the state the tool had already declared.
- `ArtifactPanel.tsx` and `page.tsx` failed to open the panel for the same
  reason. Their tests match by PREFIX, so `preview_doc` covers `preview_document`
  as well — the reverse is false, which is the whole bug.

The blank panel only showed when a run had previewed a document but not yet
generated one. Once `generate_document` ran, its result carried
`document_state` under a name the set did list and the panel filled in — which
is why this survived: it looked like a slow panel rather than a broken one.

### Notes

`U34` derives the names it expects from the registry instead of restating them:
`_as_json` is applied to exactly the tools whose results the panel reads, and
`functools.wraps` leaves `__wrapped__` behind, so that attribute is the signal.
A future rename moves the test with the tool. `analyze_template` is exported
unwrapped and returns no `document_state`, so it is correctly out of scope —
the first version of this case did not make that distinction and failed on it.

Mutation-tested: restoring `preview_document` in the set and in `page.tsx` turns
`U34b` and `U34d` red, naming `preview_doc` as the missing tool.

Verified on the same run that produced the report: `preview_doc` now reaches the
panel, which shows 3/11 at that point in the flow — before a director is picked,
so nationality, NRC and date of birth are correctly still outstanding.

## [1.2.66] — 2026-08-27

### Fixed — the card stopped suggesting what the system cannot know

The People register holds four things per person: name, NRC/passport,
nationality, date of birth. Measured on the live box, all 9 people have all
four — and `residential_address`, `country_of_residence`, `phone`, `email`,
`father_name` and `business_occupation` are empty for every one of them. They
are empty because a DICA extract does not carry them; the director object it
publishes has eight keys and none of those are among them.

That is why those fields are asked. But the model, composing the question,
offered **"Myanmar" as a one-click chip for COUNTRY OF RESIDENCE** — inferred
from the nationality it could see. The drafting skill forbids exactly this, in
as many words: "If it is missing for a signatory, ask; do not infer it from
nationality." A Myanmar national resident in Singapore has a different answer,
and the consent form states where the director RESIDES.

- **Chips are dropped for facts the register cannot hold** — country of
  residence, residential address, personal phone, personal email. The question
  survives; only the suggestion goes, so the user types what is true instead of
  clicking what was guessed. Enforced in the card, because the card is the only
  place these answers are given. The tool now tells the model the same thing, so
  it stops writing them in the first place.

- **Every date box opens on today** and stays editable, rather than only the
  ones the model marked `default: "today"`.

  ⚠ This RELAXES a deliberate rule. The tool's own guidance reads: "Never on an
  effective or resignation date: a pre-filled box that the user accepts without
  looking would put today's date into a signed legal instrument." Asked for
  directly, and implemented as a SHOWN default — the value is visible in the box
  and the user still has to submit — but the exposure is real: an execution date
  accepted without reading is now today's date rather than an empty box that
  would have stopped the run.

### Notes

Admin editing of those six fields already worked and was verified end to end
rather than assumed: writing an address, country, phone and email onto a
director through `PUT /api/people/{id}` took that document from **6/11 to
10/11**, leaving only `date` outstanding — which is a choice, not a stored fact.
The demo values were reverted afterwards. That is the loop worth knowing about:
fill the register once per director and every future consent form for that
person stops asking.

`U33` runs the card's OWN regex against real question text rather than checking
that a line exists, and asserts that legitimate chip questions — template
choice, approval, meeting location, nationality — keep their options.

Two cases failed their first mutation test and were rewritten. `U33n` asserted a
call that also appears elsewhere in the file, so narrowing the date seeding back
left it green; it is now scoped to the seed block. `U33p` read `__doc__` off the
`@tool` WRAPPER, which carries a docstring of its own, so it was testing the
wrong text entirely — it now reads `entrypoint.__doc__`, which is what the model
is actually shown.

## [1.2.65] — 2026-08-27

### Fixed — the panel was computing a different, wrong answer

1.2.64 taught the resolver to read the People register, and the product still
looked unfixed. The question card correctly stopped asking for a director's
nationality and date of birth; the Fields panel beside it went on showing both
as PENDING, showed NRIC as PENDING, and displayed the COMPANY's registered
office — phone number and legal@ mailbox included — under the DIRECTOR's
`address`.

Nothing was stale. Three pieces of code each decided independently whether a
field was filled: generation and the Fill-in view through `find_replacement`,
and the Fields panel through `_resolve_from_data` alone — which cannot see the
People register at all, and which answers `address` from the bare alias the
company record publishes.

- **One resolver, three views.** `_resolved_values` runs `find_replacement`
  across the template's fields once and returns both the resolved values and the
  genuinely blank ones. Every `_document_state` call site now builds its panel
  from that, and `prepare_document_data` decides what is outstanding from it
  rather than from name-matching against company columns.

- **`ready` can no longer contradict `outstanding`.** They were computed
  separately, so the panel could show fields pending on a document it also
  called ready.

- **`address` stopped claiming a default it does not have.** It was exempt from
  the value check because a bare `address` always resolved — from the company's
  own alias. That reading is refused now, which is the point, so the exemption
  only kept the field out of the missing list and therefore never asked.

Measured on the same template and company: the panel went from 3/11 with a wrong
address to **6/11**, and its outstanding list is now identical to the Fill-in
view's — `address, country_of_residence, date, email, phone`, every one of them
genuinely absent from the register.

### Notes

`U32` pins the invariant that was missing, and both halves were mutation-tested:
putting one call site back to the raw company record turns `U32e` red, and
deriving `outstanding` from name-matching again turns `U32g` red. `U32g` failed
that test on its first attempt — it asserted a variable NAME that a mutant still
contained — and now asserts the call.

## [1.2.64] — 2026-08-27

### Fixed — the register already knew, and the form asked anyway

A director was picked from the card. The People register held
`nationality = Myanmar` and `date_of_birth = 1987-09-21` for him, and the
consent form asked for both as free text — while showing "Myanmar" in the very
picker row the user had just clicked.

Two bridges exist between a picked person and their own attributes, and both
were keyed on a ROLE PREFIX: `director_nationality` resolves, bare
`nationality` does not. `Director Consent Form - Non-Group Member
Appointment.docx` writes every one of them bare, so neither bridge could see
them and the register was never consulted.

- **A bare attribute now belongs to the only person in the document.** The rule
  is deliberately narrow: exactly ONE single-person slot in the template. With
  two — a resigning director and a new one — a bare `nationality` genuinely is
  ambiguous, and guessing would print one person's details beside the other's
  name. Ambiguous still asks.

- **`nric` could never resolve as an identifier.** The identifier pattern listed
  `nrc`, `nrc_no`, `passport`, `identification_number` — not `nric`, the exact
  spelling this template uses. It appeared filled in testing only because the
  model happened to pass it through `custom_data`; the same document generated
  again could leave it blank. It is now answered by code.

- **The company's registered office was being filled in as the director's home
  address.** `prepare_document_data` republishes the company record under
  several aliases, one of which is a bare `address`, so it won the exact-match
  tier long before any person lookup ran. The form's own trained description
  reads "Residential address of the appointed director"; what it got was
  "BARGAYAR ROAD ... LEGAL@CITYHOLDINGS.COM.MM". A blank gets proof-read. A
  confident wrong address does not — this was the worst of the three.

  The register has no home address on file for him, so the field is now blank
  and asked. That is the correct outcome, and it is a field fewer than before.

- **One attribute table, not two.** `fill_view` carried its own copy and the two
  had already drifted — its copy never listed `nric`. It now reads the table in
  `slot_resolver`.

### Notes

The first diagnosis of the address defect was wrong: a loose token-subset match
was blamed, and `address` turns out to be a GENERIC token that tier refuses
outright. `U31w` is the negative control that caught it, and it now pins the
real path instead. Strict mode was kept anyway, as a guard rather than the fix —
`nationality` IS a token subset of `nationality_of_ultimate_holding_company`,
and that tier would have answered it (`U31xa` / `U31xb`).

`tracker_layer1` gained `date of birth` to its register-owned date list, on the
same principle as `financial year` and `auditor`: a birth date is a fact the
register owns, not an event the user picks. The four cases that changed still
assert that the SIGNING date on those forms stays blank.

Verified end to end on the real template and company: `nationality`,
`date_of_birth` and `nric` resolve from the register; `address`, `email`,
`phone` and `country_of_residence` are blank and asked, because the register
genuinely holds nothing for them.

## [1.2.63] — 2026-08-26

### Added — `super_admin`, and an honest label for `editor`

The roles were `user` / `editor` / `admin`. `super_admin` was asked for
repeatedly, and it is a real distinction in a firm: several people manage
templates, companies and people day to day; far fewer should decide who can
sign in at all.

- **`migration_032`** widens `chk_users_role`. Without it every attempt to
  create or promote a super administrator fails as a constraint violation from
  the database — an opaque 500 rather than anything an administrator could act
  on. Nothing is promoted by the migration: widening what is allowed and
  deciding who gets it are separate acts, and the second is the firm's.

- **You cannot grant a role above your own.** That is the whole rule, chosen
  because it cannot lock anybody out: an admin still creates admins exactly as
  before, so a deployment with no super administrator keeps working, and only a
  super administrator can mint another. Enforced on **both** creation and
  update — checking only creation would be decorative, since you could make a
  plain user and then edit them upward.

### Fixed

- **`require_admin` compared `role != "admin"` by equality**, which refuses
  the tier that is meant to do strictly more — on every admin route at once. A
  brand-new super administrator would have been locked out of the entire panel
  by the check that exists to admit them. Now compared by rank, as are both
  `sso_only` break-glass sites.

- **`editor` was labelled "manage registers" and grants nothing beyond
  `user`.** Every write goes through `require_write`, which demands admin, so
  an editor was shown the management screens and got 403 on every save — a
  promise the UI made and the API refused. Relabelled "view only (same as User
  today)" until it is either given real write access or retired. The honest
  label is the fix; the capability decision is yours.

### Verified live, not just asserted

| | |
|---|---|
| admin creates a super_admin | refused — "You cannot create an account with the super_admin role." |
| super_admin signs in | 200, role `super_admin` |
| super_admin reaches `/api/admin/users`, `/auth-settings`, `/activity-logs` | 200, 200, 200 |
| super_admin creates a super_admin | allowed |
| admin promotes someone to super_admin | refused — "You cannot grant the super_admin role." |

`U28h`–`U28j` cover the rank gates and both grant paths. Full sweep: units 299,
`tracker_layer1` 25/25, `tracker_layer2` 30, `tracker_layer3` 16,
`tracker_fill` 52.

## [1.2.62] — 2026-08-26

### Added — a guard against the wrong legal instrument

The worst defect this product has produced is not a missing field. Roughly two
runs in eleven on the client's tracker, `generate_document` was called with a
template that contradicted the request:

    request:  "director consent form (non group member) for Win Win Tint"
    call:     generate_document(template_name="Individual Shareholder Consent Form.docx")

A Shareholder Consent is not a Director Consent — different thing consented to,
different signatory, different filing. It comes out filled correctly and looking
right, which is exactly why nobody catches it. Nothing tested it.

`scout/tools/template_guard.py` refuses a template that states the OPPOSITE of
the request on an axis where the two are different instruments: director vs
shareholder, group vs non-group, resignation vs appointment, individual vs
corporate.

It is deliberately one-sided. It does not choose a template — it blocks a
clearly wrong one, which is a far smaller and more reliable job than picking the
right one. Silence on either side is never a contradiction, so an ambiguous
request behaves exactly as before, and asserting BOTH sides is not a clash
either ("resignation and appointment" is a real template the firm uses).

**The request text is read from the stored run record, never taken as an
argument.** An argument would be filled in by the model, and the model is the
thing being checked — a paraphrase cannot contradict the template its own author
picked. It is the user's raw words or nothing, and "nothing" means proceed.

A guard that breaks must not break generation: every failure path returns "no
opinion" and the document is produced as before.

### Verified

`U30a`–`U30f`, 16 checks. All five real drift cases from the tracker are
refused; seven legitimate requests — including the matching template, an
unrelated request, and the both-sides "resignation and appointment" case — pass
through untouched. Driven end to end through the real tool against a real
session row: the wrong template is refused with a message naming both options,
the right one proceeds to the ordinary signatory picker.

Full sweep unchanged: units 284, `tracker_layer1` 25/25, `tracker_layer2` 30,
`tracker_layer3` 16, `tracker_fill` 52.

### Note on A2b

`tracker_layer1` A2b — *Notice of AGM to Shareholders offers people to pick* —
fails on the AWS box and **passes locally, 25/25**. The deployed copy of that
template has been hand-edited on the server (30,807 bytes against 26,510 in
git). So it is a data problem with that one file, not a code defect; it needs
the committed copy restored once the firm confirms which version is theirs.

## [1.2.61] — 2026-08-26

### Fixed — answering a question card now continues the run

Every human-in-the-loop flow in this product — template choice, person picker,
confirmations — resumes through `POST /runs/{id}/continue`. It had been dead:
the card went to ANSWERED, no reply ever came, the run stayed `PAUSED` in the
database with `answered=null`, and the POST returned 200.

**Two different bugs, one identical symptom**, which is why fixing the first
looked like no progress at all.

1. **`SecurityHeadersMiddleware` read the request body** to bind the session id.
   It is a `BaseHTTPMiddleware`, and reading a body there makes Starlette cache
   and replay the request; its `wrapped_receive` then hands an `http.request`
   to the SSE response's `listen_for_disconnect`, which raises
   `RuntimeError: Unexpected message received: http.request` after the first
   event has been flushed. 12 occurrences in 12 attempts. Moved to
   `ResumeSessionScope`, plain ASGI, outside every `BaseHTTPMiddleware`.

2. **That replacement then fabricated a disconnect.** Once the buffered body
   was spent it returned `{"type": "http.disconnect"}` — and
   `listen_for_disconnect` is waiting for exactly that, so it read it as the
   client hanging up and cancelled the response generator. Quieter than the
   crash and just as fatal.

The `stream=false` comparison is what separated them, because the streaming
path swallows whatever the generator raises:

| | time | events | result |
|---|---|---|---|
| `stream=false` | 5.4s | — | **COMPLETED**, `answered=True` |
| `stream=true` (broken) | **0.1s** | `RunContinued`, `ToolCallStarted` | still `PAUSED`, `answered=null` |
| `stream=true` (fixed) | 3.7s | 12, incl. `RunContent`×3, `RunCompleted` | **COMPLETED**, `answered=True` |

0.1s meant it never reached the model. The resume logic was never at fault —
`acontinue_run` worked correctly the whole time, which also rules out the tool
round-trip and the worker count.

`_receive` now delegates to the real transport once the body is spent: it
blocks until the client genuinely goes away, and a real disconnect still
propagates.

### Added

- **`U29a`–`U29g`**, driving the ASGI middleware directly — no model, no
  network, no server. Mutation-tested against **both** historical bugs:
  fabricating a disconnect fails `U29c`/`U29d`; replaying the body forever
  fails `U29f`. `U29g` fails if any `BaseHTTPMiddleware` reads the request body
  again, which is the original crash at its source.

  The existing tracker suites could not have caught this: they drive a scripted
  runtime rather than real HTTP, which is how 261 tests passed while the
  product's core interaction was dead.

### Verified

Three consecutive resumes, `answered=true` on all three, 3.5–3.8s each. In a
real browser: ask → card → click → the document panel opens with *Annual
General Meeting Minutes.docx — City Holdings Limited*, fields resolved 5/13,
and a signatory picker asking to choose who signs. Previously: nothing at all.

## [1.2.57] — 2026-08-26

### Added

- **View-only access to the registers.** Anyone signed in can now open
  Overview and Registers — templates, companies, people, documents, emails,
  skills — and read them. Creating, changing and deleting stays with
  administrators, and Settings stays administrator-only.

- **A "Sign in with …" button for the directory**, asked for directly because
  the text-only hint left people looking for a button and concluding the
  feature was missing. It is a second submit control for the same form, not a
  separate journey — because there isn't one: directory sign-in uses the same
  two fields and the server decides which credential store answers.

### Fixed — an authorisation hole

**Nineteen mutating routes had no role check at all.** Ten of them change
shared firm records and could be called by any signed-in account, viewer
included:

    DELETE /api/knowledge/sources/{filename}   POST /api/dashboard/add/company
    POST   /api/dashboard/upload/template      POST /api/dashboard/bulk/generate
    POST   /api/company/upload-pdf             POST /api/company/extract-pdf-stream
    POST   /api/documents/sync                 POST /api/knowledge/sync/templates
    POST   /api/templates/categories           POST /api/training/save-logs

All ten now go through `require_write`. The nine left open are each the
signed-in person's own work — their chat title, their follow-ups, their message
feedback, approving or discarding an email they were shown, and generating a
document, which is the product rather than an edit to a register.

- **`editor` was decorative.** The only mention of the role on the server was
  the validation list on user creation. An editor was shown the register
  management screens and got 403 on every write they attempted — a promise the
  UI made and the API refused. The ranking now lives in one place
  (`ROLE_RANK`), `require_write` is the single bar, and `U28f` fails if the
  browser's ranking and the server's ever disagree.

- **A gate that crashed instead of authorising.** `set_template_category`'s
  body parameter was named `request`, the same name FastAPI uses for the HTTP
  request — so the role check was handed the JSON dict and raised. It failed
  closed, but it broke the route for administrators too. Caught only because
  the verification ran the same writes as an admin as a control: the viewer's
  403 looked fine on its own, and the admin's 500 is what exposed it.

### Notes

- The browser half is a rendering convenience, never the boundary.
  `ConfirmButton` renders nothing for a viewer — every one of its eighteen uses
  is destructive, so the rule lives in the component instead of at eighteen
  call sites — and each register view shows a plain "view-only" notice so a
  restricted page is not mistaken for a broken one. The server refuses the
  request regardless of what was drawn.
- `super_admin` does not exist in this product; the roles are `user`, `editor`
  and `admin`, and `admin` is the top. Nothing was invented to match the name.

### Verified with a real viewer account against the real endpoints

Reads 200 (`/api/dashboard/data`, `/api/people`, `/api/dashboard/stats`,
`/api/skills`). Ten writes attempted: **10/10 refused 403**, with the same ten
as an administrator as a control to prove the endpoints were not simply broken.

## [1.2.55] — 2026-08-26

Reported from the live deployment after configuring a real Active Directory:
*"there is no way to test, no testing button, no way to log in on the login
screen, no button."* All three were true.

### Fixed

- **A directory could be configured but never tested.** The Authentication tab
  had a connection test for the identity provider and none for the directory —
  so an administrator could fill in a host, a bind DN and a filter, save, and
  have no way to learn whether any of it worked short of asking a real person
  to try signing in. `POST /api/admin/auth-settings/test-ldap` binds as the
  service account and runs one search — steps 1 and 2 of a real sign-in. It
  deliberately cannot test step 3, the rebind that proves a password, because
  that needs a real person's credentials and a settings page must not ask.

- **★★★ An Active Directory username could not sign in at all.** `auth_login`
  rejected anything that was not a valid email *before any LDAP call*, and the
  login field was `type="email"`, so the browser refused to submit a bare
  username too. AD people overwhelmingly know their `sAMAccountName`, not the
  address Legal Scout files them under — and the filter people write is usually
  a `(|(sAMAccountName=…)(userPrincipalName=…)(mail=…))` OR, which can only
  ever match if a username is allowed through. The whole directory feature was
  unreachable for them, answering "Invalid email format" with no hint that a
  username was even a possibility.

  A non-email identifier is now resolved through the directory — it
  authenticates the username and returns `mail`, which is matched to a Legal
  Scout account. This is the one path that necessarily sends an unrecognised
  identifier to the directory; there is no other way for username sign-in to
  work, so it is reachable only with the directory deliberately switched on,
  and the email path still refuses to do it.

- **A malformed search filter saved silently.** The one written on the live
  deployment was `((sAMAccountName={username})(userPrincipalName={username})
  (mail={username}))` — three conditions with no operator joining them, which
  is not valid LDAP. The directory rejects it, every sign-in fails as an
  ordinary wrong password, and nothing says why. Filters are now checked at the
  write, like the enums, and the message names the fix (`(|` in front).

- **Directory sign-in was invisible.** It correctly has no button — it uses the
  same two fields, so a second button would be a second way to submit one form
  — but nothing on the screen said the option existed. When a directory is
  configured the field now reads "EMAIL OR USERNAME" and a line under the
  button says staff can use their network credentials. Configured, working and
  unadvertised is indistinguishable from absent.

- **`U24a` asserted the live value instead of the default**, so it went red on
  a deployment where an administrator had legitimately switched the directory
  on. A test that fails because someone used the feature has the wrong
  assumption, not the product.

### Verified against a real OpenLDAP

| | |
|---|---|
| malformed filter | refused at the save, message names the fix |
| test button, valid config | "Bound as the service account and searched … — 1 matching entry visible" |
| **username + directory password** | **200** (previously impossible) |
| username + wrong password | 401 |
| email + directory password | 200 |
| unknown username | 401 |

## [1.2.53] — 2026-08-26

### Fixed

- **A pinned API endpoint left the composer permanently dead, and the server
  never heard about it.** `store.ts` persisted `selectedEndpoint` to
  localStorage, but that field is *defined* as `window.location.origin` — so
  persisting it only ever recorded where the app happened to be opened FIRST in
  a given browser, and then forced every later visit to talk to that origin
  instead of the one serving it.

  Measured on the AWS deployment. The app had been opened once at
  `http://<ec2-ip>:3001`, pinning that value; afterwards, on
  `https://legalscoutagent.citygpt.xyz`:

  | call | URL built from | result |
  |---|---|---|
  | `/api/knowledge/train-job`, `/api/email/queued` | `NEXT_PUBLIC_API_URL \|\| ""` → relative | **200** |
  | `/agents`, `/sessions`, the status probe | `selectedEndpoint` → absolute | blocked as mixed content |

  So the page polled happily while the agent list never loaded, and the
  composer disabled itself with "Select an agent to start". The server side
  confirms it: **zero `/agents` requests** in the whole window around the
  report, while `/api/*` calls from the same tab were logging 200s. It was
  never refused — it was never asked.

  `selectedEndpoint` is no longer persisted. `version: 1` on the store is as
  load-bearing as that: without the bump, browsers already holding the bad
  value keep rehydrating it and stay broken, so the bump makes zustand discard
  the old state and an affected browser repairs itself on the next load with
  nobody clearing anything by hand.

  Verified both ways in a real browser against a deliberately poisoned value:
  pre-fix build → composer disabled, placeholder "Select an agent to start",
  bad value retained; fixed build → storage rewritten to `{"state":{}}`, agent
  selected, composer enabled.

- **A momentary blip at page load stranded the user with no explanation.**
  `getStatus()` caught its own failure, returned 503 once, and everything
  downstream gates on `status === 200` — no toast, no console entry, no retry.
  Now retried three times with a short backoff, and if it truly cannot reach
  the backend it says so instead of leaving a dead input on a page that looks
  signed in.

## [1.2.52] — 2026-08-26

Phase 4, the last of the sign-in work: **Settings → Authentication**. Every
directory and provider setting becomes editable from the admin panel, plus the
sign-in mode and just-in-time provisioning. Nothing changes for a deployment
that leaves it alone.

### Added

- **`app/auth_settings.py`** — one rule: the environment is the default, a row
  in `app_settings` overrides it, read fresh on every sign-in. Reuses the table
  that already holds the model, SMTP and S3 settings, under an `auth.` prefix;
  a second key/value store for the same job would have been the drift.
- **Settings → Authentication** — sign-in mode, the directory block, the
  provider block, both auto-create switches, and a connection test that reads
  the discovery document and the key set (the same path a real sign-in takes,
  so a pass means what sign-in depends on actually works).
- **`signin_mode`** — `local` | `hybrid` (default) | `sso_only`.
- **Just-in-time provisioning**, off by default for both sources.
- **`U26a`–`U26t`.**

### The check that stops this being a decorative page

`U26a` fails if `ldap_auth.py` or `oidc.py` reads any variable declared in the
settings spec straight from the environment. Without it, the failure mode is
the one this codebase keeps producing: an administrator saves a corrected host,
the row is written, the page shows the new value, and sign-in goes on using the
one from `.env` with nothing anywhere to say so. Same family as the dead SSO
button and the Inactive badge that never fired.

### Rules, and the reason for each

- **Secrets are write-only.** `oidc_client_secret` and `ldap_bind_password` can
  be saved and cannot be read back; the API reports set / not set. A page that
  renders a client secret puts it in the DOM, in the browser's memory and in
  any screenshot of that page. A blank secret on save means *keep*, not
  *clear* — the form cannot show the current value so it posts blank every
  time, and treating that as a clear would wipe the secret the first time
  anybody edited an unrelated field.
- **Enums are validated before the write, and a rejected save writes nothing.**
  `signin_mode = "sso-only"` (a hyphen) would store fine, read back as
  unrecognised and fall through to the default — so a deployment meant to be
  SSO-only would go on accepting passwords while the page showed exactly what
  was asked for.
- **`sso_only` is applied after the password is verified, and always exempts an
  administrator.** Checked earlier, the differing status code would enumerate
  which addresses have accounts. Without the exemption, one mistyped provider
  URL locks every human out — including whoever has to sign in to fix it — and
  the only way back is editing Postgres by hand.
- **Just-in-time provisioning removes the typing, not the approval.** `role`
  and `approved` are SQL literals in `_jit_provision`, which takes no argument
  for either, so no claim, group, mapper or caller can reach them: an
  auto-created account is always `role='user'`, always `approved=FALSE`, and
  lands on the pending screen. `ON CONFLICT DO NOTHING`, because two parallel
  sign-ins by the same new person is the ordinary case — a browser reloading
  the callback does it.
- **Nothing is cached in this process.** Two workers, no shared store: a value
  cached at import in one is stale in the other the moment somebody saves, so a
  setting would appear to take effect or not depending on which worker
  answered. `U26q` guards it, as `U23k` and `U25b` do for the other two.

### An honest note on `ldap_auto_create`

It is the one switch here that genuinely widens the attack surface rather than
only saving typing. Phase 2 deliberately refused to contact the directory for
an email with no account, so this public form could not relay arbitrary
guesses to corporate Active Directory — password spraying, with the account
lockouts that causes for real staff. "The directory decides who exists" makes
that relay unavoidable. It is off unless switched on, the settings page says so
in as many words, and the account still lands pending — but it should not be
turned on for an internet-facing deployment whose directory locks accounts out.
The provider equivalent has no such cost: the person authenticates at the
provider and no credential passes through here.

### Landmine, caught again by its own guard

`LDAP_AUTO_CREATE` and `OIDC_AUTO_CREATE` were added to the settings spec and
**not** to `compose.yaml`, so they would never have reached the container — the
same allowlist trap that made `LDAP_ENABLED=true` a no-op in phase 2. `U24n`
and `U25q`, now driven off `auth_settings.SPEC` rather than off a regex over
the source, went red naming both variables. Fixed, along with `SIGNIN_MODE`.

### Verified live

An override saved through the admin API changed `/api/auth/config` in the same
running process with nothing restarted. `signin_mode="sso-only"` refused at the
write, naming the permitted values. The client secret is stored, never
returned, absent from the whole payload, and survives an unrelated save.

| sign-in mode | ordinary user | administrator | `/api/auth/sso/login` |
|---|---|---|---|
| `hybrid` | 200 | 200 | offered |
| `sso_only` | **403** — must use single sign-on | **200** | offered |
| `local` | 200 | 200 | **403** |

The `sso_only` row is the break-glass working: the ordinary account is refused
and the administrator is not.

## [1.2.50] — 2026-08-26

Phase 3: **single sign-on (OpenID Connect)**. Off by default. The button that
has been on the sign-in page since it was written now does something.

### Added

- **`app/oidc.py`** — authorization-code flow with PKCE, `state`, `nonce`, and
  `id_token` verification against the provider's published JWKS.
- **`GET /api/auth/sso/login` / `GET /api/auth/sso/callback`**.
- The **existing** SSO button is wired, and now renders only when the server
  says single sign-on is configured. Same markup, same position, same styling —
  a wiring change, not a redesign.

### Fixed

- **The SSO button did nothing.** It had no `onClick` at all — only a tooltip
  reading "Ask your administrator to enable SSO". It has been shipping to the
  client as a clickable control with no behaviour. It is now either functional
  or absent: a button that cannot work is better not drawn.

### How the token is verified, and why each rule is there

- **The algorithm is pinned to the asymmetric ones and never read from the
  token.** Trusting the header's `alg` permits the confusion attack: sign with
  HS256 using the provider's *public* key as the HMAC secret. Attempted against
  the running verifier with a hand-crafted token (PyJWT refuses to mint one, so
  it was built with raw HMAC — an attacker is not using our library): refused.
- **No "use the first key in the set" fallback.** On a rotation the first key is
  the new one while the token in hand was signed by the old, so the fallback
  turns a precise "unknown key id" into a confusing signature error, and invites
  accepting a token verified against a key it was not signed with. An unknown
  `kid` refetches the key set exactly once.
- **Audience accepts `aud` *or* `azp`.** Keycloak puts `aud: "account"` in its
  id_tokens and names the client in `azp`, so a plain audience check rejects
  every real login against a default realm. Skipping the check entirely would
  accept a token minted for a different application on the same realm.
- **`state` is checked against a signed, HttpOnly cookie.** Without it an
  attacker hands somebody a callback URL carrying the attacker's own
  authorization code, signing that person into the attacker's account, where
  everything they then do is visible to the attacker.
- **The token is handed back in the URL FRAGMENT.** The frontend is a static
  export with no server route that could receive it, so it has to arrive in the
  URL — and a fragment is never sent to the server, never written into an access
  log and never carried in a `Referer` header. It is stripped from the address
  bar on arrival so it does not sit in history.
- **`SameSite=Lax`, deliberately not `Strict`.** The callback is a top-level
  navigation from the provider's domain; `Strict` would withhold the flow cookie
  and every sign-in would fail as "no sign-in cookie", reading like a browser
  fault rather than a configuration one.
- **No state is kept in this process.** Two uvicorn workers, no shared store —
  anything stashed in module memory by `/sso/login` is absent when the callback
  lands on the other worker, and sign-in would fail about half the time while
  looking like an intermittent provider fault. `U25b` fails on any mutable
  module-level state in `app/oidc.py`; the first draft had exactly that, in a
  `_pending_nonce` dict, and it was removed before it ran.

### The provider proves identity. It grants nothing.

No just-in-time provisioning on this path: an authenticated stranger with no
Legal Scout account is refused, not created. Roles are never read from the
token, so whoever administers the realm cannot make themselves a Legal Scout
administrator with a group mapping. And SSO does **not** walk past phase 1 —
the same approval gate applies, with the same wording.

### Verified against a live Keycloak 26

A throwaway realm, confidential client, PKCE S256, fictional user; the whole
flow driven end to end (authorize → login form → callback), then torn down.

| case | result |
|---|---|
| correct password, account exists and approved | **token issued** |
| wrong password | refused at Keycloak, never reaches us |
| authenticated, but no Legal Scout account | refused — "ask an administrator" |
| forged `state` on the callback | refused |
| forged `code` on the callback | refused |
| approval revoked, then sign in again | refused — pending approval |
| account disabled, then sign in again | refused — disabled |

`auth_sources` merged to `{local,oidc}`; role untouched; the issued token works
on `/api/` and on the AgentOS routes.

**Forged tokens, put through the real verifier — 6 attempted, 0 accepted:**

| forgery | outcome |
|---|---|
| HS256 signed with the provider's public key | refused on algorithm |
| `alg=none` | refused on algorithm |
| RS256 signed by an unrelated key, real `kid` | refused on signature |
| RS256 with a `kid` absent from the key set | refused — no key, no fallback |
| **genuinely signed by Keycloak, minted for another client on the same realm** | refused on audience |
| wrong issuer | refused |

The audience row is the one worth noting: two of the earlier forgeries failed on
*signature* rather than on the specific check, because they were signed with my
own key. So a second client was created on the same realm and a real token
minted with Keycloak's own signing key — valid signature, correct issuer, only
the audience different. Refused, naming `aud` and `azp`.

## [1.2.49] — 2026-08-26

Phase 2 of LDAP/SSO: **directory sign-in**. Off by default. **No change to the
sign-in screen** — a directory sign-in uses the same email and password fields,
because the directory is a fallback behind the local password rather than a
second way in.

### Added

- **`app/ldap_auth.py`** — bind as a read-only service account, search for the
  person, then **rebind as their own DN** with the password they typed. Only
  that last step proves anything: binding as the service account proves the
  service account's password, and finding an entry proves only that the entry
  exists. A version that stopped after the search would admit anybody named in
  the directory, with any password.
- **`migration_031`** makes `hashed_password` nullable, so an account can exist
  with no Legal Scout password at all. Leave the password blank in Settings →
  Users and the person signs in with their directory password; nothing is
  stored here for them. Generating a random password instead would have left a
  real, never-rotated local credential on an account whose whole purpose was to
  have none.
- **`GET /api/auth/config`** — public, booleans and a display label only. No
  host, no bind DN, no filter: it is served to anyone who can reach the login
  page, and it says nothing about any particular account.
- **`U24a`–`U24n`.**

### Security properties, and why each is written the way it is

- **Empty passwords are refused before any bind.** A simple bind with a valid
  DN and a zero-length password is an *unauthenticated* simple bind (RFC 4513
  §5.1.2), and some Active Directory deployments answer **success** — on those,
  knowing any provisioned address would be enough to sign in as that person.
  The guard is in `authenticate()`, not only in the endpoint, because this is
  the function that decides whether a password is right.
- **Plaintext binds are refused, not warned about.** The flow rebinds as the
  user, so their password crosses the wire on every sign-in. A warning is a log
  line nobody reads until after the credentials have been collected, and
  nothing looks broken meanwhile. `LDAP_ALLOW_INSECURE=true` is the explicit
  override.
- **The directory is only consulted for an account that already exists, and
  only after the local password failed.** Trying it first, or for unknown
  emails, turns a public login form into a password-spraying proxy for Active
  Directory — with the account lockouts that causes for real staff.
- **The address the directory returns must match the one signing in.** A filter
  that matched a different entry — an alias, a shared mailbox, a filter someone
  widened — would otherwise sign whoever holds *that* password into *this*
  account.
- **Nothing on this path writes a role or an approval.** The directory proves
  who someone is; the `users` table decides what they may do. Whoever
  administers the corporate directory cannot make themselves a Legal Scout
  administrator by editing a group.
- **Every failure answers with the same flat 401.** "No such entry", "wrong
  password" and "the directory is unreachable" told apart are an enumeration
  oracle; the distinction goes to the log, where an administrator needs it and
  an attacker cannot read it.

### Landmine closed: compose's `environment:` is an ALLOWLIST

Setting `LDAP_ENABLED=true` in `.env` did **nothing**. `compose.yaml` names
each variable it passes through, so anything not listed never reaches the
container and the app silently reads its default: `/api/auth/config` answered
`"ldap_enabled": false`, no directory was ever contacted, every directory
sign-in failed as an ordinary wrong password, and there was no error anywhere
to explain it. Found by running it, not by reading it. `U24n` now asserts that
every `LDAP_*` variable `app/ldap_auth.py` reads is actually present in the
container's environment — checked at runtime rather than by parsing
`compose.yaml`, which is not in the image and would only have produced a skip.
Mutation-tested by removing one variable: red, naming the variable.

### Verified against a real OpenLDAP

A throwaway directory on the compose network, fictional people, torn down
afterwards:

| case | result |
|---|---|
| directory user, correct directory password | **200** |
| directory user, wrong password | 401 |
| directory user, empty password | 401 |
| in the directory, no Legal Scout account | 401 |
| `*)(objectClass=*` as the username | 401 |
| local admin, unchanged | 200 |

The merge was exercised separately: an account created with a local password
signs in locally (`auth_sources = {local}`), then signs in with its directory
password (`{local,ldap}`), then again (**still** `{local,ldap}` — idempotent),
with the local password still working and the role untouched.

**Honest limit.** The positive case above was proven over plaintext with the
explicit insecure override, because the test image's own TLS was broken — its
bundled certificate had expired, and after replacing it slapd still aborted the
handshake at the socket level, from a plain Python client as well as from the
app. TLS enforcement and certificate validation were proven separately, and by
genuine negative controls rather than by assertion: the no-TLS config was
refused before any bind, and the expired certificate was rejected by
verification. What has **not** been exercised end to end is one successful
sign-in over validated TLS.

## [1.2.47] — 2026-08-26

Phase 1 of LDAP/SSO groundwork: the approval gate. No directory and no identity
provider yet — this is the control that makes adding them safe, and it ships and
is useful on its own. **No change to the sign-in screen.**

### Added

- **`users.approved` — an administrator has to let an account in**
  (`migration_030`). Until now every account was created by an administrator
  typing it in, so approval was implicit; the only other state was `is_active`.
  That stops holding the moment a directory can authenticate somebody this
  application has never heard of. Also adds `auth_sources TEXT[]` — a list, not
  a value, so one person holding a local password *and* arriving through a
  directory stays one row with one role rather than two rows that drift apart.

- **`POST /api/admin/users/{id}/approval`** — approve or refuse, with its own
  audit line. Refusing holds the row at `approved = false` rather than deleting
  it: a deleted account is re-created by the same person simply signing in
  again, so the refusal would have to be repeated every time.

- **Settings → Users** gains a `Signs in via` column, an `Access` column, a
  pending banner, a Pending stat card and Approve/Refuse actions on pending
  rows only.

- **`U23a`–`U23j`** in `tests/test_units.py`. The structural cases walk the AST
  rather than grepping — the comments around this feature contain the exact
  strings a regex would look for, so a text-scan version of `U23d` would pass
  with the gate deleted and the explanation left behind.

### Fixed

- **A disabled account rendered as Active in the admin panel.**
  `GET /api/admin/users` returns `is_active`; `UsersView.tsx` read `u.status`,
  which the API has never sent. Every read was `undefined`, the `|| "active"`
  fallback beside each one always won, so the green Active badge showed on
  disabled accounts, the Inactive stat card sat permanently at 0 and `rowTone`
  never fired. Third decorative control found on this page's stack this week.

### Landmines closed before they shipped

- **The middleware decodes a JWT in two places, and only one is obvious.**
  One branch guards the AgentOS/static roots (`/agents`, `/sessions`, the run
  stream, the documents tree), the other guards `/api/`. Gating only `/api/`
  locks a refused account out of the admin panel while leaving chat, the agent
  and document generation working — the entire product, behind a control that
  looks present. Measured against a deliberately half-gated build, refused
  account, same still-valid token:

  | surface | both gates | `/api/` gate only |
  |---|---|---|
  | `GET /api/auth/me` | 403 | 403 |
  | `GET /sessions` | 403 | **200** |
  | `POST /agents/scout/runs` | 403 | **200** |

  `U23d` counts the calls in the AST and fails on either deletion; both
  mutations were run and both turned it red.

- **The background training worker would have locked itself out.**
  `training_jobs.py:376` mints `create_token(0, "system@training", "admin")` and
  drives the 15-step pipeline through this app's own HTTP endpoints, so it
  passes the same gate a browser does. `users.id` is `SERIAL` from 1, so id 0
  matches no row and fails closed — killing all template training, and
  surfacing as a per-template 403 in a job log rather than as anything that
  looks like an auth problem. Carved out as `SYSTEM_USER_ID`, which grants
  nothing: minting that token already requires `JWT_SECRET_KEY`.

- **The seeded admin would have come up pending.** `approved` defaults to
  FALSE, and the bootstrap `INSERT` did not name it — so on a fresh install the
  only row in the table would have been unapproved, with nobody left who could
  approve it. `U23f` fails on any `INSERT INTO users` that omits the column.

- **The migration backfills existing accounts to approved.** Without it, the
  first boot after deploy locks out every account including the administrator
  running it. Safe precisely because every pre-existing row was hand-created.

- **An in-process cache made revocation a coin flip, and nearly shipped.**
  The gate first cached its answer for 30s in a module-level dict, busted on
  every write. That reasoning is sound in one process and wrong in two:
  `Dockerfile:92` runs `--workers 2`, so a bust reaches only the worker that
  served the write while the other keeps serving its cached answer. Measured on
  the baked image, refused account, token still valid:

  | surface | with the 30s in-process cache | without |
  |---|---|---|
  | `GET /api/auth/me` | 403 | 403 |
  | `GET /sessions` | **200** | 403 |
  | `POST /agents/scout/runs` | **200** | 403 |

  Identical to the half-gated failure above — and worse than a slow revocation,
  because it is non-deterministic: refused here, admitted there, depending on
  which worker answers. It also means the hand-verification that had already
  "passed" this check passed on a coin flip. `_APPROVAL_TTL` is now `0`, and
  `U23k` reads the worker count out of the Dockerfile so it cannot be raised
  again without a shared store. Re-verified with 30 consecutive hits per
  surface rather than one: **90 of 90 refused, zero stale.**

### Notes

- Approval is read from the **database on every request**, not from the token,
  so revocation is not deferred to token expiry and does not depend on which
  worker answers. The cost is one connection and one indexed lookup per
  request; `get_db_conn()` has no pool, which is the thing to fix if this ever
  shows up in a latency measurement. Middleware runs once per HTTP request, so
  an open SSE stream pays it once, not once per chunk.
- Login answers 403 with `pending_approval: true`, and does so **after** the
  password check, so the differing status code cannot be used to enumerate
  which addresses have accounts.

## [1.2.45] — 2026-08-26

### Fixed

- **CI has been failing on every run for months; it is green now.**
  `integration-test` died in its first second on
  `docker compose -f compose.yaml -f compose.dev.yaml` — `compose.dev.yaml` has
  never existed in this repo, so the health, auth and metrics steps behind it
  had never executed once. It now runs against `compose.yaml` with `PORT=8001`,
  and no longer writes a dead `OPENAI_API_KEY` into the test env.

- **A circular import that had been latent for months.**
  `db/session.py` imported `app.model_config` at module scope, which pulls in
  `app/__init__` → `app.main` → `from db import ...`, re-entering `db.session`
  while it is still executing. Whether that actually broke depended on which
  module got imported first, so it survived until an import sorter reordered
  two lines alphabetically. The import is now deferred to call time, removing
  the cycle rather than restoring a fragile line ordering.

- **`U17` could be broken by a code formatter.** Its regex required
  `frozenset({` with no whitespace between the paren and the brace, so
  reformatting the declaration failed a security check whose control was fully
  intact. Loosened to `\s*`; mutation-tested to confirm it still fails when
  `"documents"` is removed from or renamed in `STATIC_PROTECTED_ROOTS`.

### Changed

- **`ruff` rule set is now declared explicitly in `pyproject.toml`.** With no
  `select`, ruff applies whatever its current defaults are, so a new release
  silently adds rules and turns CI red without a line of this code changing —
  which is exactly how CI came to sit failing with 1,306 errors it had never
  been asked to enforce. `BLE001`/`S110` (deliberate broad catches so boot
  cannot die), `DTZ` (naive vs aware datetimes are part of the wire contract),
  `E402` (deliberate lazy imports) and `RUF001-003` (NBSP and friends are
  load-bearing in template placeholder matching) are excluded with reasons.

- **1,306 lint findings resolved**: 55 files formatted, 775 auto-fixed, 280
  fixed under `--unsafe-fixes`, and the remaining 39 by hand — 14 exception
  chains, a closure over a loop variable (`B023`), two mutable class defaults
  now `ClassVar`, and 14 printf-style format strings. `B008` is configured
  away for FastAPI's `File`/`Depends`/`Query` idiom rather than rewritten.

- **`mypy` is report-only.** 247 genuine type errors across 28 files (98
  `arg-type`, 31 `union-attr`, 27 `assignment`). Left visible in the CI log
  rather than deleted or faked green; drop `continue-on-error` at zero.

### Verified

`tests/test_units.py` and eleven trackers produce byte-identical results on
`1.2.42` and `1.2.45` — same passes, same pre-existing failures (`U16`, and two
in `tracker_assets`). Container boots clean: 29 migrations, knowledge and
skills refreshed, no errors.

## [1.2.42] — 2026-08-25

### Fixed

- **An empty value from the model no longer erases what the user typed.**
  The client's first logged defect — "the System asked the information, but the
  provided information are not used in the exported document" — reproduced with
  a boundary and fixed.

  It only appears on the flow a real user takes: answer the question cards, then
  send "now generate" as a SEPARATE message. Captured from a failing run,
  `generate_document` was called with

      {"date": "", "date_of_birth": "", "phone": "", "email": "", ...}

  while `active_task.collected` held `{"date": "07 July 2027"}` from the card
  the user had just filled in. `smart_doc.py:1058` merged them as
  `{**_remembered, **custom_data}` — caller wins on every key it sends — so the
  empty string won and the consent form came out with no date at all.

  The caller winning was right for corrections and wrong for omissions, and the
  model omits by sending `""`, not by leaving the key out. Now an empty caller
  value is dropped when a remembered non-empty value exists for the same key.

      remembered      caller           result
      07 July 2027    ""            -> 07 July 2027   (model dropped it)
      07 July 2027    08 Aug 2027   -> 08 Aug 2027    (real correction)
      -               ""            -> ""             (deliberate blank)
      07 July 2027    (absent)      -> 07 July 2027

  `_explicitly_supplied` still reads PRESENCE, so "leave the effective date
  blank" is unaffected — that path never had a remembered value to lose, because
  `merge_collected` only stores what the user actually typed.

  Measured, two-message flow, date present in the .docx:

      1.2.40   2 of 5
      1.2.42   9 of 9   (on every run that used the correct template)

### Known defect — NEW, not fixed

- **Template drift: the model sometimes generates a different document than the
  user asked for.** Roughly 2 runs in 11. Seen: an *Individual Shareholder
  Consent Form* generated for a request naming a *Director Consent Form*, and a
  *Group Member* consent for a request naming *Non-Group*. Captured:

      request:  "director consent form (non group member) for Win Win Tint"
      call:     generate_document(template_name="Individual Shareholder Consent Form.docx")

  This is worse than a missing field — it is the wrong legal instrument. It also
  explains the remaining "no date in document" results: the Individual
  Shareholder Consent Form has no date placeholder at all, so the absence is a
  symptom of the drift, not of the merge. No test covers template choice across
  a multi-message flow.

## Unreleased — Phase 3 investigated and REVERTED

### Not shipped

- `max_tool_calls_from_history=3` (agno's `filter_tool_calls`, the
  context-editing pattern) was implemented, baked as 1.2.41, measured against
  1.2.40 and **reverted**. Post-document turns averaged 60,487 input tokens
  without it and 55,036 with — 9% — but individual turns ranged 33k to 75k in
  both arms, so the effect is smaller than the run-to-run variance. Shipping a
  change whose effect cannot be separated from noise is not a win, and one run
  with trimming on auto-filled TODAY'S date into a consent form, which is the
  client's second logged defect.

### Found while measuring — bigger than the token work

- **The signing date reaches the document only ~60% of the time when the user
  sends "now generate" as a SEPARATE message**, which is what a real user does.

      flow                                     date in .docx
      answer cards, generation continues       3/3   (single flow)
      answer cards, then "now generate"        2/5   on 1.2.40
                                               4/5   on 1.2.41

  On the failing runs the date is absent entirely; on one it was replaced with
  the current date. Present on BOTH builds, so it is not caused by anything in
  the context work — the trimming arm was, if anything, slightly better.

  The answers are not lost: `active_task.collected` holds
  `{"date": "07 July 2027", ...}` for these sessions and `smart_doc.py:1054`
  reads it. Something in the second-message path is not applying it.

  ⚠ Also seen in the same runs, on both builds: the WRONG TEMPLATE generated —
  Group Member for a request naming Non-Group, and once an Individual
  Shareholder Consent for a Director Consent request. No current test covers
  template drift across a multi-message flow.

  This is the client's "the System asked the information, but the provided
  information are not used in the exported document", reproduced with a
  boundary. It outranks the remaining context/token phases.

## [1.2.40] — 2026-08-25

### Changed

- **`find_matching_templates` returns 23% less: 9,160 → 7,095 characters.**
  Measured on one live turn, its payload was `playbook` 3,732, `matches` 3,015,
  `agent_instruction` 1,458, `message`+`options` 705. Two of those were dead
  weight:

  - `matches` carried a full filesystem path and an internal match score for
    each of 13 candidates. The model addresses templates by NAME
    (`prepare_document(template_name=...)`) and the chat UI reads only
    `name`/`display_name`/`selected_template`/`error`/`suggestion`/
    `clarification_needed` (`toolDisplay.ts:461`). The score still drives
    ranking and the dominant-match test — it just stops riding along.
    3,015 → 1,691.
  - `message`/`options` were a lettered a)/b)/c) menu that the instruction in
    the same payload explicitly forbids relaying, read by nothing. Deleted,
    along with the builder that made them. 705 → 0.

  Guard: skill routing still 3/3 on all four A/B prompts; document generation
  unchanged.

### Measured, no change made

- **The 5-run history window does NOT corrupt the exported document.**
  A card answer stops being *conversationally* recallable at exactly 5 padding
  turns — `num_history_runs=5` — and the model then answers "Signing Date: None
  provided" (0/3 at 5, 7 and 9 turns; 2/3 at 0 and 3). That looked like the
  client's "the provided information are not used in the exported document".
  It is not. `ask_questions` persists answers to `active_task.collected`
  (`task_memory.merge_collected`), and `smart_doc` reads them when it fills
  (`smart_doc.py:1054`), so the DOCUMENT is right regardless of the window —
  verified end to end at 0 and 7 padding turns, 2 runs each: supplied company,
  supplied date and the register person all present, no auto-filled date.

  What is real, and smaller: `collected` never reaches conversation context, so
  a user who asks "what have I told you so far?" late in a thread is told
  nothing was provided. Wrong answer, right document.

  ⚠ Seen once in two runs at 7 padding turns: the GROUP Member template was
  generated for a request that named NON-GROUP. Template choice drifting after
  a long conversation is not covered by any current test.

- Gemini caches implicitly — 24,386 tokens of the 31,209-token floor are served
  from cache with no `cache_control` anywhere in this codebase (that syntax is
  Anthropic-only and would be a no-op here). 8,785 tokens miss on every turn;
  what they are is not yet established.

## [1.2.39] — 2026-08-25

### Added

- **The governing playbook now rides along with a template match**
  (`LEGAL_SCOUT_SKILL_ROUTING`, default OFF).

  All 15 templates are already named in a `legal_skills` body, and
  `new-company-setup` carries the exact answer the combined director+shareholder
  request needs — the full consent set and who signs each. It never loaded.
  Skills are PULL: `agent.py` tells the model to call `load_skill` when a request
  matches a description, and the model decides. Measured on 1.2.37, 3 runs each:

      "what documents are required to set up a company?"     load_skill  3/3
      "prepare resignation letter of ... from City Holdings"  load_skill  3/3
      "director consent form ... to appoint in a new company" load_skill  0/3
      "appoint X both as a shareholder and director"          load_skill  0/3

  Writing more skills does not fix that; it adds more things that may not load.
  So `find_matching_templates` returns the body itself — the model cannot skip a
  payload it is already holding, and there is no second call to forget.

  A/B on the same build, 3 runs per prompt:

      case                     routing OFF   routing ON
      both roles, new company      0/3          3/3
      director consent, new co     0/3          3/3
      which docs to set up         3/3          3/3
      resignation letter           3/3          3/3

  Documents still generate with the flag on; no auto-filled dates; supplied
  values still reach the .docx.

- Template→skill routing is derived, not a hand-kept table: setup group first,
  then ordered name rules, most specific before least ("resignation and
  appointment" must not be claimed by the plain "appointment" rule). A template
  matching nothing routes to NO skill rather than a plausible wrong one — an
  unrelated playbook is worse than none, because the model follows it.

- The shortlist's playbook is the majority skill of the SHOWN options, falling
  back to the leader's. Unanimity was the first rule and it almost never held:
  the loose match predicate drags a Resignation Letter in on the word
  "director", so a plain "director consent form" request attached nothing 2 runs
  in 3 even though its leading candidates were all setup consents.

### Known limits

- Routing does not fix the gap sentence. Naming that a requested document is
  absent still rests on the agent prompt and still measures ~1 in 3: the other
  runs make the `ask_questions` card their entire turn and write no prose at
  all. Two different problems — this release solves the first.

## [1.2.36] — 2026-08-25

### Fixed

- **A document that does not exist came back as a picker of near neighbours.**
  Tracker case N5 asks for a combined *Director and Shareholder Consent Form* —
  a template the register does not hold, and which the tracker itself marks
  `(new template)`. Measured on 1.2.34, the system answered with a card offering
  the two director consents and the individual shareholder consent, and said
  nothing about the gap. Whichever the user picked, they took it for the
  document they asked for and got half of one.

  `find_matching_templates` could not report absence. Its only absence branch is
  `len(matches) == 0`, and that branch is unreachable for any request phrased in
  this domain's vocabulary: the match predicate admitted a template when ANY
  word longer than two characters appeared in its name, so `and`, `for`, `new`
  and `non` all counted as evidence. Measured against the 15-template register,
  "Director and Shareholder Consent Form" matched **13 of 15** — `and` alone
  admits three, on the substring in "Resignation and Appointment".

  Three changes:

  - Structural words are no longer evidence (`_STOPWORDS`), in both the match
    predicate and `_calculate_match_score`.
  - When no single template covers every significant word of the search, the
    result carries `partial_match: true` and an instruction to state the absence
    before offering anything. A partial match is never treated as dominant, and
    a lone partial match no longer short-circuits to `prepare_document`.
  - The template-picker instruction now requires one sentence of reply BEFORE
    the card, naming the gap when none of the options is the document asked for.

  The agent prompt carries the matching rule: *a picker that does not contain
  what they asked for is an absence, not a choice* — the companion to the
  existing "never name a template you did not get from a tool". That rule stops
  the model inventing a name; this one stops it substituting a real one.

### Known limits

- The `partial_match` detector fires on requests whose vocabulary is foreign to
  the register ("Share Transfer Agreement" → the card says *"We don't have that
  exact template"*). It cannot fire on N5, because the register genuinely
  contains every word of "director shareholder consent" — the missing document
  is a *combination*, and the gap is semantic, not lexical. A coverage test
  against the user's full request was built and rejected: it flagged four
  currently-passing tracker cases (N1, N2, N4, C7) as unavailable, which is a
  worse defect than the one being fixed.

- Naming the gap on N5 therefore rests on the agent prompt, measured at **3 of 6
  runs**. The other three call `ask_questions` as their entire turn and write no
  prose at all — the run pauses at the tool call, so a card can be a whole turn.
  No run generated a wrong document. Making the sentence unconditional needs
  `ask_questions` to carry a code-supplied preamble the UI always renders.

- N5 still cannot be generated. That needs
  `Director and Shareholder Consent Form.docx` from the client.

## [1.2.30] — 2026-08-25

### Fixed

- **An answer the user typed into a question card could be lost entirely.** The
  last structural cause behind the client's most-repeated complaint, *"the
  System did not use the provided information"*.

  A card answer survived only if the MODEL chose to forward it into the next
  call's `custom_data`. Measured on the client's tracker: the same AGM Minutes
  template kept the meeting date on one run and dropped it on the next —
  `generate_document` was called with no date key at all — and the document came
  out with `Date:` empty. Nothing on the server had ever seen the answer.

  `ask_questions` could not store it, because it could not learn its session:
  a `requires_user_input=True` tool must not declare `run_context` (agno builds
  `user_input_schema` from `sig.parameters` with no exclusions, the frontend
  echoes the schema back on resume, and the entrypoint then receives it twice —
  TypeError, and the card never executes). The pickers work around this by
  having their `lookup_*` companion publish the session id in its payload;
  `ask_questions` has no companion.

  So the session is now bound at the REQUEST layer instead. The middleware
  reads `session_id` off the `/runs/{id}/continue` body and binds
  `slot_resolver.session_scope` for the whole request, so every tool downstream
  can read it without declaring anything. The body is replayed to the app
  afterwards — consuming it without putting it back would hand agno an empty
  form. Verified by probe that the contextvar does propagate through
  `BaseHTTPMiddleware`, which spawns the downstream app in its own task.

  `ask_questions` then writes its answers into `active_task.collected`, and
  `generate_document` merges them back in.

  ★ `merge_collected` is UPDATE-only — it needs a task row to attach to — so
  `_preview_doc` now records the task as well. Previewing comes FIRST in the
  ordinary flow and the questions are asked against it; with only
  `generate_document` recording, every answer given before the first generate
  call still had nowhere to go. That distinction is the difference between
  2-of-3 and 4-of-4:

      1.2.26 / 1.2.27 (before)   0 of 2 runs kept the date
      1.2.29 (scope binding)     2 of 3
      1.2.30 (+ preview records) 4 of 4

## [1.2.27] — 2026-08-25

### Fixed

- **An answered date could be silently dropped when the model named it more
  specifically than the placeholder.** Found by replaying the client's tracker
  (AGM Minutes): the agent asked `meeting_date`, the user answered
  "07 July 2027", and the document came out with `Date:` EMPTY. The template's
  placeholder is `date`, and no tier of `_resolve_from_data` matched
  "meeting_date" to it. The SAME template on the next run happened to ask under
  `date` and filled correctly — so the value was lost purely because the model
  chose a more specific id, which makes it look like flakiness rather than a
  rule.

  A final tier now lets a qualified key answer a bare `date` placeholder, under
  two constraints:

  * The key must be in a CLOSED list (meeting, signing, signature, notice,
    effective, resolution, consent, document, letter, minutes, agm,
    appointment, resignation). The obvious general rule — any key whose tokens
    include "date" — would let `date_of_birth` fill the date of a legal
    instrument, which is a worse document than a blank one.
  * Exactly ONE qualified date must be present. A meeting date AND a signing
    date means the caller distinguished them, and picking either would put one
    date where the other belongs.

  An exact `date` still wins, and the tier never fires for a non-date
  placeholder. 13 cases including both dangerous ones.

## [1.2.26] — 2026-08-25

### Fixed

- **The new-company binding had no effect on the finished document.** 1.2.24/25
  set `data["company"]` to the company being incorporated, and the log line
  confirmed it fired — but the .docx still read "To: CITY HOLDINGS LIMITED".

  `find_replacement` never consulted `data` for that placeholder. Its
  `source == "db"` branch answers company-identity fields straight from the
  register row (`_get_company_from_db(company_name)`) and returns, so the
  override wrote a value nothing ever read. The company being formed has no
  register row at all, and the row that WAS looked up belongs to a different
  client.

  A `NEWCO_MARKER` on the fill data now reaches that branch, which returns the
  new company for a name field and "TBC upon incorporation" for the
  registration number (or a supplied number, if there is one). Scope is
  deliberately narrow — only name and registration number. Blanking the other
  register-sourced fields would trip the undeclared-blank guard on values the
  consent forms never render.

  Verified end to end. The document now opens:

      CONSENT TO ACT AS DIRECTOR
      To: ZENITH ORCHID VENTURES LIMITED
      Company Registration Number: TBC upon incorporation

  with no trace of the other company or its registration number. And the
  regression that mattered: the Corporate Shareholder Consent still names
  PAHTAMA GROUP as the resolving parent with its own registration number, while
  the NewCo appears only where it belongs — "hereinafter referred to as ZENITH
  ORCHID VENTURES LIMITED ("NewCo")". Replacing the parent there would have
  inverted the instrument.

## [1.2.25] — 2026-08-25

### Fixed

- **1.2.24 would not boot.** The prompt rule added in that release contained a
  literal `custom_data={"new_company_name": ...}` inside the `INSTRUCTIONS`
  f-string. Single braces there are a format specifier, so importing the module
  raised `ValueError: Invalid format specifier` and every worker died at
  startup. Braces escaped to `{{ }}`.

  Worth recording HOW this got through: `ast.parse` cannot catch it — the file
  is syntactically valid and the failure happens when the f-string is
  evaluated at import. The brace scan that was supposed to catch it only
  covered four lines after the heading, and the braces sat further down. The
  check that actually works is enumerating every `FormattedValue` in the file
  and confirming none of them is an accidental dict literal — plus, in the end,
  booting the image.

## [1.2.24] — 2026-08-25

### Fixed

- **A consent form for a company being incorporated was addressed to an
  existing client instead.** Found by replaying the client's testing tracker
  (case "Setup 1"). The agent correctly asked "What is the name of the new
  company?", the user answered "ZENITH ORCHID VENTURES LIMITED", and the
  document still came out reading

      To: CITY HOLDINGS LIMITED
      Company Registration Number: 119510619

  The answer was collected and then silently discarded: `company_name` is in
  `PROTECTED_FIELDS`, so custom_data carrying it is stripped before the fill,
  and the form kept the register company used for the lookup. That is worse
  than a blank — a signed consent would attach the director to a DIFFERENT
  client entity, carrying that entity's real registration number.

  `PROTECTED_FIELDS` is unchanged; it genuinely stops the model overwriting
  company identity on an ordinary document. The escape is explicit instead: a
  dedicated `new_company_name` key, which the model must pass deliberately, and
  which the prompt now describes. The registration number becomes
  "TBC upon incorporation" — the client's own wording — unless one is supplied.

  ★ The override applies ONLY when the template does not itself render a
  separate `new_company_name`. Measured placeholder sets: Director Consent
  (Non-Group) has `company` + `company_registration_number`; Individual
  Shareholder Consent has `company_name`; Corporate Shareholder Consent has
  `company_name`, `company_registration_number` AND `new_company_name`. That
  last template names TWO companies — the parent passing the resolution and the
  NewCo being formed — and overwriting `company_name` there would replace the
  parent with the NewCo and invert the whole instrument. `canonical_field`
  keeps the two keys distinct (verified), so the test is sound, and the
  inversion is covered by its own regression case.

  A supplied registration number is read out of `custom_data` DIRECTLY rather
  than trusted to be in `data`: it is a protected field, so a caller-supplied
  number was stripped upstream and `data` still holds the REGISTER's number.
  Checking "was it supplied" and then leaving `data` alone would have kept the
  wrong company's number — the very defect being fixed. Caught by the test, not
  in production.

## [1.2.23] — 2026-08-25

### Fixed

- **The sidebar history took a long time to appear.** The backend was not the
  cause: measured, `/health` answers in 0.01s, `/teams` 0.01s, `/agents` 0.05s
  and `/sessions` 0.05s — about 0.15s of server time in total. The wait was
  sequencing on the client, and it was doubled.

  `Sessions` refused to FETCH until `isEndpointLoading` went false, and refused
  to RENDER for the same reason. Both put the history behind `initialize()` —
  three sequential calls ending in `GET /agents`, whose response is **125,390
  bytes** because it carries the agent's entire **105,113-character
  system_message** plus 22,252 bytes of tool schemas. Nothing in the UI reads
  either field (zero references to `system_message` anywhere in `agent-ui/src`),
  so the chat list waited on a download it had no use for, twice.

  Everything the session fetch needs — endpoint, mode, agent id, db id — is on
  the URL and available on the first render. `canLoad` was always the real
  precondition; endpoint loading never was. The render guard now holds a
  skeleton only while there is genuinely nothing to show AND nothing can be
  loaded, so rows that arrive early are painted immediately instead of being
  hidden under a skeleton until `initialize()` finishes.

- **`GET /agents` no longer ships the system prompt to the browser.**
  `system_message` and `tools` are trimmed from the response, taking it from
  125KB to roughly 3KB. Besides the weight, the old payload handed the entire
  prompt to any logged-in browser. The route belongs to agno
  (`agent_os.get_app()`), so it is trimmed on the way out rather than
  redefined; only those two unused keys are dropped, and anything unexpected —
  wrong status, wrong content type, unparsable body — passes through exactly
  as agno produced it.

  Note for editors: this returns `StarletteResponse`, not `Response`. The bare
  name is not bound at module scope in `app/main.py` (line 184 imports it
  aliased), and a bare `Response` would be a NameError on every `/agents` call.

## [1.2.22] — 2026-08-25

### Fixed

- **Chat history disappeared from the sidebar on refresh.** The rail rendered
  its history slot as `{mounted && isEndpointActive && <Sessions />}`, and
  `isEndpointActive` starts FALSE in the store — it only flips true once
  `initialize()` has finished. So on EVERY page load that slot rendered nothing
  at all, and if `initialize()` was slow, failed, or never re-ran it stayed
  blank permanently: no list, no skeleton, no message, no error. Indistinguishable
  from an account with no chats.

  The gate also made its own explanation unreachable. `Sessions` renders a
  skeleton while `isEndpointLoading`, and `SessionBlankState` carries a
  `case !isEndpointActive:` that says "Endpoint offline" — both written for
  exactly the states the parent refused to mount them in. That branch could
  never execute.

  `Sessions` now mounts whenever the rail does and owns those states itself:
  skeleton while loading, "Endpoint offline" when the endpoint is down, the
  list when there is one. Same silent-empty class that was fixed INSIDE
  `Sessions` (where "broken" and "empty" were the same value), one level up in
  the parent that decides whether it gets to run at all.

  Measured while diagnosing: the backend was never at fault. `/sessions` with
  the rail's exact query (`type=agent&component_id=scout&db_id=scout-db&user_id=1`)
  returns 20 rows, `/health` answers 200 in 10ms, and `/agents` and `/teams`
  both return 200 — so every explanation involving the API was ruled out before
  the frontend was touched. Worth noting for next time: `/health` is public
  while `/agents`, `/teams` and `/sessions` are all 401 without a token.

## [1.2.21] — 2026-08-25

### Added

- **The server now remembers what a conversation is trying to produce.**
  Measured on a real session (3be25e3c, on 1.2.20): the agent found the right
  template, previewed it, took approval, was correctly told to pick the signing
  directors, ran the picker — and then, in its own reasoning,

      "Now I am trying to determine what the next logical step would be.
       Should I proceed with the task or report this successful action?
       I'm checking the original context..."

  ...called `list_templates` and started over. Seven model calls, 754,577
  tokens, $0.198, and no document. Every assistant turn was empty; the user had
  to type "continue" to unstick it.

  Nothing on the server remembered the goal. `session_state` was `{}`, and
  `party_selections` records WHO was chosen but not WHAT is being made. Between
  the pause and the resume the goal lived only in the model's attention, and at
  ~25,100 tokens of system prompt per call that is the first thing to go.

  `active_task` (migration 028) holds the resolved template, the company, and
  the values gathered so far. `generate_document` records it, every picker
  confirmation now ends by naming it, and it is cleared once the document
  exists. The stored template is the RESOLVED filename, so a read-back cannot
  reintroduce the prefix ambiguity of 1.2.15.

  **This also retires the `custom_data` hazard rather than restating it.**
  `custom_data` does not accumulate between calls, so anything the model omits
  is blank in the document — the cause of 1.2.14 and 1.2.18. Telling the model
  to re-send everything is a rule prose cannot enforce. `collected` now
  accumulates those values server-side and merges them back in, with the
  caller winning on every key it sends so a correction is never overwritten by
  a stale value.

  Every task-memory call is best-effort and wrapped: a DB failure degrades to
  the old behaviour and can never fail a generation.

### Notes

- `ask_questions` deliberately does NOT get the pending-task sentence. It is
  `requires_user_input=True`, and such a tool must not declare `run_context` —
  agno builds `user_input_schema` from `sig.parameters` with no exclusions, the
  frontend echoes the whole schema back on resume, and the call then receives
  `run_context` twice (TypeError), so the card never executes. There is no
  `lookup_*` companion to publish the session id the way the pickers do. Wiring
  it to an empty string was reverted: dead code that looks live is how the next
  person concludes this is already handled.

- The ~25,100-token system prompt was measured but NOT cut. A third of it is
  template metadata the agent genuinely uses, 77% of input is already served
  from cache (577,588 of 747,216 on the measured session), and the real cost
  driver was seven round trips producing nothing — which is what task memory
  addresses. Cutting the prompt on cost alone, with no evidence of what is
  dead, would be a behaviour change bought with a guess.

## [1.2.20] — 2026-08-25

### Fixed

- **`POST /api/session-title` returned 500 for every call.** Postgres could not
  infer the placeholder type inside `jsonb_build_object('session_name', %s)` —
  that argument is polymorphic ("any"), so the driver got
  `could not determine data type of parameter $1`. Cast to `%s::text`.

  Caught by testing the endpoint live rather than trusting that it parsed. The
  handler's own `except` had turned the driver error into a generic
  "Could not set title", so only the log line named the cause.

## [1.2.19] — 2026-08-25

### Added

- **Chats are named after what they produced, not after what was typed.** Agno
  titles a session with the user's literal first message, so the sidebar filled
  with truncated half-sentences — and, per the comment on
  `AGENTOS_PROTECTED_ROOTS`, with real company and director names. A chat that
  generates a document is now titled
  `Corporate Shareholder Consent · City Holdings`.

  Open WebUI solves this by asking a task model for a 2-4 word title. We do not
  need to: by the time the first document tool runs we already KNOW the template
  and the company as structured data, so `deriveSessionTitle` reads them off the
  tool args. No tokens, no latency, cannot hallucinate, cannot fail. It returns
  null when a run carries no document evidence, and the caller then leaves the
  existing name alone rather than inventing one — a chat that never touches a
  document keeps its first message, which for a one-line question is already the
  right title.

  Written to `session_data.session_name` through `POST /api/session-title`
  (verified against the live table: that key is what `GET /sessions` reads).
  Ownership and write happen in ONE statement — a check-then-update would race,
  and a NULL-`user_id` row from before migration 027 must not be claimable by
  whoever asks first. A session that exists but belongs to someone else returns
  the same 404 as one that does not exist, so the endpoint is not an existence
  oracle over other users' chats. The call is fire-and-forget and fires at most
  once per session: a failed rename must never disturb a run, and re-titling on
  every later turn would rename the chat under the user mid-conversation.

### Fixed

- **Follow-up suggestions appeared underneath question cards.** `MessageFeedback`
  has had a `!isQuestionTurn` guard from the start; `SuggestionButtons` never
  got one. A turn ending in a card is asking the user something, and offering
  three OTHER things to ask beside the Submit button competes with the question
  they must answer to get their document.

- **The follow-up parser accepted exactly one shape and failed silently on the
  rest.** It did `json.loads(content.strip().strip("`"))` and required a BARE
  array; an object, a ```json fence, or a sentence before the JSON all raised,
  and the caller's bare `except` turned that into an empty list with no trace.
  That is how follow-ups sat dead behind their hardcoded fallback after a model
  change. `_parse_follow_ups` now accepts the object we ask for, a bare array,
  either one embedded in prose, a fenced block, and `[{"question": …}]`, and
  returns [] only when there is genuinely nothing usable. 14 cases, including
  the exact truncated `[\n  "` that was measured in production.

  Note for anyone editing that function: `re` is NOT bound at module scope in
  `app/main.py` (line 630 imports it as `_re`), so it is imported locally. A
  bare `re` there would raise NameError straight into the same swallowing
  `except`.

### Changed

- **Follow-up prompt now carries the three rules Open WebUI's template has and
  ours lacked**, each of which produced a wrong suggestion here: written from
  the USER's point of view (without it the model writes the assistant's next
  line — "I can prepare that for you" — as something the user is asked to
  click), do not repeat what the answer already covers, and use the
  conversation's primary language. That last one matters: this is a Myanmar
  product, and a Burmese question was getting English follow-ups. Output is now
  requested as `{"follow_ups": [...]}` rather than a bare array.

- **Titles and follow-ups run on a separate `task` model purpose** instead of
  `chat`, so background UI work can be pointed at a cheaper, faster model
  without touching the model that writes legal documents. It defaults to the
  same model, so nothing changes until an admin sets one — naming a model ID
  that may not exist on OpenRouter would break these features silently, which
  is exactly how follow-ups died the first time.

## [1.2.18] — 2026-08-25

### Fixed

- **A blank nobody asked for no longer gets written to disk.**
  `fill_template_with_validation` already records every placeholder it replaced
  with `LEFT_BLANK`, and 1.2.12 made those visible in `unfilled_names` — but the
  file was still saved, `success` was still True, and the user was still handed
  the download link, with the summary quietly reading "Partial". For a legal
  instrument that is the wrong default: the finished .docx carries no
  `{{placeholder}}` and no `TBD`, so a blank term is invisible on the page. The
  measured example is a resolution reading "hereinafter referred to as ⎵
  (\"NewCo\")" — an incorporation with no company named.

  Generation now refuses BEFORE the save when a field would print empty and
  nobody chose that. A blank is acceptable only when it was chosen:
  `_explicitly_supplied` keys on PRESENCE, so a caller passing
  `{"effective_date": ""}` has said "leave it blank" and still generates, while
  a field never supplied has not been decided. Refusing before the write means
  no orphan file and no link to an incomplete document, and the returned
  `agent_instruction` gives the model both exits — re-send the values it holds,
  or ask the user, or pass an explicit empty string if blank is genuinely
  intended.

## [1.2.17] — 2026-08-25

### Fixed

- **A figure lost its separators on the way into the document.** Asked for
  "50,000,000 MMK, 10,000 shares, 100% ownership", the model passed 50000000,
  10000 and 100, and the shareholding table read

      10000 Ordinary Shares      50000000 MMK      100

  which is not how a Myanmar corporate instrument states a sum, and in that last
  cell is not even a percentage. Nothing in our code strips the commas — they
  are simply never sent — so presentation is now restored at fill time, in one
  place, for every template.

  `_present_number` is deliberately narrow: it fires only on a BARE integer (or
  a plain decimal for a percentage) and only for a field whose name says what
  the number means. Identifier-shaped fields — registration number, NRC,
  passport, phone, year, clause, section, serial, account — are excluded FIRST
  and unconditionally, because a registration number with thousands separators
  is a different number. Anything already carrying a separator, a currency word
  or any other character is passed through untouched. Applied before the
  idempotency hash so a re-send of "50000000" is recognised as the same
  generation as "50,000,000", and applied identically in `_preview_doc` — a
  preview showing "50,000,000" for a file that will say "50000000" is worse
  than no preview, because the user approves the version they were shown.

- **A dominant template match was still put to the user as a question, and the
  model sometimes answered it wrong.** Searching "Corporate Shareholder Consent
  - Directors Resolution" returns 12 matches — the word-overlap predicate in
  `find_matching_templates` admits any template sharing a single three-letter
  word — and the correct one scores 150 against a runner-up of 20. The tool
  nonetheless returned `clarification_needed: True` with twelve options. On a
  measured run the model picked from that list and produced ANNUAL GENERAL
  MEETING MINUTES for a request that named a shareholder consent.

  When the top score clears an absolute floor (50 — a prefix or full-substring
  hit) AND at least doubles the runner-up, it is now returned as the selected
  template with `clarification_needed: False`. Genuine ambiguity is untouched:
  "Director Consent Form" matches the Group and Non-Group variants, they score
  alike, the ratio is not met, and the user is still asked.

## [1.2.16] — 2026-08-25

### Fixed

- **Answering a question card could fail with "Message too large (max 50KB)".**
  The size guard in `SecurityHeadersMiddleware` applied to any POST whose URL
  contains `/agents/`, which includes `/runs/{id}/continue`. That endpoint does
  not carry a message: resuming a paused run posts the ENTIRE tool payload back,
  and that payload is generated by us — picker candidates, preview results,
  document state.

  Measured on an ordinary Corporate Shareholder Consent flow, resume bodies run
  11KB–25KB (a single `preview_doc` result is 6.5KB, `find_matching_templates`
  6.3KB), and a longer run crossed 50,000 and was rejected. To the user that is
  a card that silently refuses to submit, on a document they have already
  answered every question for — and nothing they can type makes it smaller.

  The 50KB limit is about what a person can type, so it now applies only to run
  creation. The resume path keeps a bound, since an unbounded body is still a
  denial of service, but one sized for a tool payload (2MB) rather than a
  sentence. The exemption is matched on `url.path`, not the whole URL, so
  `?next=/continue` on a create request cannot buy the larger limit.

## [1.2.15] — 2026-08-25

### Fixed

- **A template name that did not match a filename exactly made the agent write
  the wrong document.** Asking for the "Corporate Shareholder Consent -
  Directors Resolution" — a true PREFIX of the real filename, which ends "…for
  New Company Setup and Director Appointment.docx" — produced a complete,
  well-formed set of ANNUAL GENERAL MEETING MINUTES instead, containing none of
  the requested terms.

  `prepare_document_data` and `analyze_template` both looked the template up by
  exact filename, with only underscore/space variants as a fallback, and on a
  miss returned `Template not found: <name>` naming no alternative. A model
  given no near match does the worst available thing, which is guess.

  Both now resolve through `_resolve_template_name`, which matches in tiers —
  exact filename, underscore/space variants, then case- and
  punctuation-insensitive equality, unique prefix, unique substring — and
  returns a match ONLY when it is unique. Two candidates mean the caller has
  not said which document it wants, and picking one is how a Director
  Resignation gets written on an AGM Minutes form; ambiguity now returns the
  candidates plus an instruction to ask the user, and refuses to generate.

  The resolved name is adopted by `_generate_document_inner` and `_preview_doc`
  from `template_analysis.template`. Without that the request passes analysis
  and dies one screen later on a second, unresolved path lookup — and a preview
  built from an unresolved name would disagree with the document generation
  then produces.

  Membership is tested against the real directory listing rather than
  `Path.is_file()`: macOS is case-insensitive, so `is_file()` accepts
  "director resignation letter.docx" and would hand back the caller's spelling
  — a name that does not exist inside the Linux container the product runs in.
  Caught by the test, not in production.

## [1.2.14] — 2026-08-25

### Fixed

- **A document could be generated with its legal terms blank, and the hole was
  in our code, not the model.** The Corporate Shareholder Consent came out
  reading "hereinafter referred to as ⎵ (\"NewCo\")" and "the Company shall
  invest in ⎵ in NewCo" — a resolution incorporating a company that is never
  named, for a sum never stated — roughly 1 run in 4, on 1.2.12 as well as
  1.2.13. It presented as model flakiness. It was not.

  `_generate_document_inner` gated its entire missing-user-input check behind
  `if field_classification and not custom_data:`. The gate therefore skipped the
  moment ANY custom_data was present — and the party-slot guard immediately
  above it instructs the model to make exactly that call: "call
  generate_document again with `custom_data={<slot>: <chosen name>}`". The model
  complies with the party names alone, `custom_data` becomes truthy, and every
  remaining user-input field slips past unchecked and resolves to `LEFT_BLANK`.
  Whether the document came out correct depended only on whether the model
  happened to re-send values it had already been given.

  The gate now runs ALWAYS and asks the honest question: is this field
  resolvable from the company record MERGED WITH `custom_data`, or did the
  caller deliberately set it? Emptiness of `custom_data` was never what
  mattered. `_explicitly_supplied()` treats PRESENCE of a key as the answer,
  not truthiness, so "leave the effective date blank" and an explicit "TBD"
  both settle a field instead of re-asking forever.

  Both instructions were wrong in the same way and are corrected: the party
  guard now asks for the chosen names PLUS every value already collected, and
  the missing-fields return carries an `agent_instruction` saying what to do
  next — previously it returned `success: False` with no instruction, which the
  model reads as a failure. Both now state the thing that was never written
  down anywhere: **`custom_data` does not accumulate between calls; anything
  omitted from the next call is blank in the document.**

  Why this one hid: the finished file has no `{{placeholder}}` and no `TBD`, so
  it passes every structural check. It reads as clean legal prose with words
  silently missing.

## [1.2.13] — 2026-08-25

### Added

- **Dates are picked from a calendar, not typed.** Every date the agent asked
  for came back through the same generic box — "Type your answer" — so an
  effective date arrived as `30/6/26`, `June 30`, or `30 June 2026` depending
  on who was typing. Nothing normalised it: `smart_doc.py` has no date handling
  at all, so whatever string the card sent is what landed in the .docx.

  A question may now carry `"input_type": "date"`. The card draws a native
  calendar, offers a one-click **Today** chip, shows a live preview of the
  value in document form, and converts the picker's ISO value to
  `30 June 2026` **before submitting** — so the agent and the document receive
  the form these instruments use, and the ambiguity never reaches the file.

  `"default": "today"` pre-fills the picker, and is accepted ONLY alongside
  `input_type: "date"`. Deliberately opt-in, and the prompt restricts it to the
  date of the document itself. A pre-filled effective date that the user
  accepts without reading would write today's date into a director's
  resignation letter — silent, wrong, and legally meaningful. `_validate_questions`
  rejects `default` anywhere else rather than leaving that to the prompt.

  Because the model does not always set `input_type` — and a prompt change ships
  in the same image as the frontend but is obeyed only probabilistically — the
  card also infers a date question from the field text. The inference uses
  `(?<![a-z])dates?(?![a-z])` rather than `\bdate\b`: the model names fields with
  underscores, and `\b` never fires inside `resignation_date` because `_` is a
  word character. The same boundaries still exclude the words that merely
  contain "date" — update, candidate, mandate, validated. A compound ask
  ("Meeting date and location?") is excluded outright, since a picker there
  would silently drop half the question, and every inferred picker carries a
  **Type instead** link, so a wrong guess can never trap an answer.

  `todayISO()` builds the date from the LOCAL calendar, not `toISOString()`:
  at UTC+06:30 the UTC form yields yesterday's date for the first 6.5 hours of
  every day.

### Known issue (pre-existing, measured this release)

- **L4 of the E2E suite is flaky at roughly 1 run in 4.** The Corporate
  Shareholder Consent is sometimes generated without the five NewCo values that
  were stated in the opening message, leaving `new_company_name`,
  `business_sector`, `subscription_amount`, `number_of_shares` and
  `share_percentage` blank in the document.

  Measured, not inferred: 4 runs on 1.2.13 → 1 failure; 4 runs on 1.2.12 →
  2 failures. So this is NOT a regression from the date picker; it predates it,
  and the earlier "31/31 twice consecutively" runs were luck rather than proof.

  The 1.2.12 validation fix is working — `unfilled_names` now names the blank
  fields instead of reporting the document complete. What still misfires is the
  agent: on the failing runs it goes straight to the approval card and generates
  without passing the values it was given into `custom_data`. Not yet fixed.

## [1.2.12] — 2026-08-24

### Fixed

- **A document with blank legal terms was reported as complete.** Found by
  driving the chat API end to end. A Corporate Shareholder Consent was produced
  reading

      ...hereinafter referred to as  ("NewCo"), shall be incorporated in the
      Republic of the Union of Myanmar, and that the Company shall invest in
      in NewCo pursuant to the table below.

  — an unnamed company, an unstated sum — while the result said 13 placeholders,
  `unfilled_names: []` and status "Complete".

  Cause: `find_replacement` returns `LEFT_BLANK` ("") for a `user_input` field
  with nothing supplied, and `validate_filled_document` works by RE-OPENING the
  saved .docx and looking for leftover `{{...}}` patterns. A placeholder
  replaced with "" leaves no pattern, so it is structurally invisible to the
  check — validation can only ever see fields left RAW.

  Generation now collects every field it empties and folds them into the
  validation: they appear in `unfilled_names`, `is_valid` goes false, and a
  warning names them in the log. Measured: the same call that reported
  `is_valid: True, unfilled_names: []` now reports five blanked fields, while a
  fully supplied document still reports valid with none — the guard moves in
  both directions.

### Added

- `tests/test_units.py` U10d–U10k pin the collector, including that noting
  outside a generation is a no-op and that the ContextVar is cleared afterwards
  (a blank attributed to the NEXT document would be worse than not reporting).
  Verified failable: removing the `_note_blank` call turns U10i red.
- `scratchpad/e2e/suite.py` — 31-check end-to-end suite driven purely through
  the public chat API, covering questions, refusals, both document families,
  download security and reply quality.

### Notes

- Still open: the agent frequently ends a turn with no visible text (measured
  1/3 to 6/7 of turns), and drops user-supplied `user_input` values instead of
  passing them in `custom_data` — which is what left the fields blank in the
  first place. The document is now honest about it; the agent is not yet fixed.

## [1.2.11] — 2026-08-24

### Fixed

- **A single signature line was expanded into the whole board.** Four templates
  were producing malformed instruments. A notice reading

      Signed notice by a Company's director calling of Annual General Meeting
      Sincerely,
      _________________________
      Name: [director_name]
      Position: Director

  came out with FOUR names stacked under one signature rule and one
  "Position: Director", and nobody was ever asked who signs. The two Director
  Consent Forms and the Individual Shareholder Consent Form had the same defect,
  where the form is signed by the one person consenting.

  Cause: giving `signing_director` a company fallback in 1.2.9 took its party
  count from 0 to the real board size, and `repeat_regions` grew every paragraph
  of that family — including paragraphs holding ONE un-numbered placeholder.
  A paragraph is now a repeating region only when its placeholder names an
  explicit position (`director_3_name`, `individual shareholder_2_name`); the
  number is the template author saying there are several of these here.

  Measured across all 15 templates: the four signature blocks stop expanding and
  each now offers ONE person blank with candidates, while every genuine list
  ("Present: [x] (Shareholder)", "Members to sign if they agree") is unchanged,
  because those spell out numbered positions. A family-based exemption was tried
  first and was worse — it left the Individual Shareholder Consent Form
  expanding one signature to five members.

### Added

- **Routines (L1) are wired.** `apply_routines_block` splices the catalogue into
  the agent instructions. Flag off returns the same object by identity, so the
  flag-off prompt is byte-identical to before the layer existed (verified:
  96,962 chars and no markers with the flag off; 97,210 with it on). Flag:
  `LEGAL_SCOUT_ROUTINES`, declared in `compose.yaml` and set in `.env`.
- `tests/tracker_regions.py` — pins the "a region needs a number" rule. 6 checks,
  3/3 controls move the number.

### Notes

- `tracker_layer1` is 25/25 for the first time.

## [1.2.10] — 2026-08-24

### Changed

- **All 15 templates now carry a trained `field_mapping`; previously 2 did.**
  The other 13 fell through to heuristics, which is where "guessed instead of
  asked" comes from. Measured before and after across every template against two
  real companies: 8 templates changed, **20 slot requests added, none removed**,
  and no placeholder stopped being asked. The system now offers a choice for
  resigning directors, newly appointed directors and signing directors on the
  meeting-minutes and written-resolution families, where it previously filled
  them from the register without asking.

### Added

- `tests/tracker_templates.py` — every `.docx` on disk must have a row with a
  non-empty `field_mapping`, every source must be `db`/`user_input`/`slot`, and
  every slot must name a kind. This condition was invisible for weeks because
  nothing counted it. 5 checks, 5/5 controls move the number.
- `scripts/template_snapshot.py` — before/after snapshot and diff of per-template
  fill behaviour, so an LLM-driven retrain is measured rather than assumed.

### Notes

- `POST /api/knowledge/deep-train` registers a template and sets `ai_trained`
  but does NOT write `field_mapping` — that comes from
  `GET /api/knowledge/train-stream/{name}`. A row reading `ai_trained = true`
  with a null mapping is therefore not trained in any sense the slot machinery
  can use.
- Known, unfixed: `GET /api/documents/fill-view` classifies blanks with its own
  regex (`fill_view._kind`) and never consults `field_mapping`. A placeholder
  correctly trained as `source=slot, kind=signatory` is still emitted as
  `kind=text` with the register's value pre-filled, so the document view keeps
  guessing where document generation now asks. This is the one remaining
  `tracker_layer1` failure (A2b).

## [1.2.9] — 2026-08-24

### Fixed

- **Twelve fields claimed a default they did not have.** `DEFAULT_FIELDS`
  exempted its members from the "does this actually have a value" check on the
  grounds that they are always filled from defaults. Measured through
  `find_replacement`, twelve of the fourteen were not: five returned the literal
  string "TBD" — and were simultaneously listed in the resolver's own
  `KNOWN_USER_INPUT` — and seven returned None, which leaves the raw placeholder
  in the document with no highlight. Because an exempt field counts as
  satisfied, none of them was ever put to the user. The set now holds only the
  two with real defaults, and a guard pins the claim so the two lists cannot
  drift apart again.

- **An empty company name silently chose a client.** `prepare_document_data("")`
  treats the empty string as a fuzzy query and returned whichever company
  matched first — an unrelated client, reported as success. Document tools now
  refuse and ask.

- **A rotated `ADMIN_PASSWORD` did nothing.** `_init_admin` only ever INSERTed,
  so an existing admin kept its old hash and the old credential kept working
  while the operator believed the secret had been rotated. It now rotates on
  change. The silent `admin123` fallback is gone: an install with no
  `ADMIN_PASSWORD` refuses to seed the account and says so.

### Added

- **The agent remembers which company a conversation is about.** A conversation
  settles its subject once, at the party picker, but nothing wrote that down, so
  later turns re-derived it from whatever the model happened to say — measured
  live, the agent re-asked which template and which parent company after both
  were agreed. The picker now binds the session to the company, and document
  tools fall back to that binding when no name is given. Binds ONLY on an exact
  match: a substring never resolves, because attaching a conversation to the
  wrong client is far worse than asking again. Flag: `LEGAL_SCOUT_MEMORY`.

- **An audit ledger of side effects.** One turn is opened per agent run, and a
  generated document is recorded against it. Flag: `SCOUT_EFFECTS_LEDGER`. Both
  flags are declared in `compose.yaml` and set in `.env`, so they survive a
  recreate.

### Notes

- Secrets rotated: `JWT_SECRET_KEY` and the admin password. All existing
  sessions are invalidated.
- `tracker_fill` 43 → 52 checks, `tracker_effects` 24 → 25, `tracker_assets`
  25 → 28. Every new case has a mutant that moves its number.
- Known, unfixed: 15 templates are on disk and only 2 carry a trained
  `field_mapping`. The other 13 fall back to guessing (for example filling a
  signing director from `directors[0]` instead of offering the choice), which is
  the one remaining `tracker_layer1` failure.

## [1.2.8] — 2026-08-24

### Fixed

- **Numbered director positions were asked about once, not once each.** A
  template declaring `director_1..3_name` and `appointed_director_1..3_nrc` —
  six placeholders, six distinct people — produced two questions. Measured live
  on a three-director company; positions 2 and 3 were never put to anyone and
  the finished document carried them blank. Two causes, one per family:
  `_parties_for_family` had no company fallback for `signing_director`, so a
  company with three directors on file still reported a party count of 0; and
  the per-position dedup engaged only when a count was known, which
  `appointed_director` can never have because the appointees are the answer
  being collected. Signing directors now fall back to the company's own board
  (via the register-first reader the pickers use, so the two cannot drift), and
  appointed directors are asked about per position the template declares.
  A company with one director on file is still asked once — the over-correction
  guard is pinned in both directions, with a mutant that reproduces the defect.

- **A field with no value counted as filled.** `validate_data_vs_template`
  decided availability purely by spelling, using a SUBSTRING test, so
  `new_company_name` matched the `company_name` column and was reported
  "available / DB" while its value was `None`. Because a resolved field is never
  asked about, the new company's name was silently blank in the output. A field
  now needs an actual value; fields with real defaults stay exempt.

- **Updating a company by name created a second, nameless company.** The path
  parameter of `PUT /api/dashboard/company/{company_name}` was unquoted into a
  local and then never used, and `add_company` upserts on the registration
  number — so a body without one INSERTED, and the endpoint still answered
  "Company updated". It now resolves the named row and refuses when the name is
  not on file. Fixing that exposed a second defect the first had been masking:
  because the upsert sets every column from `EXCLUDED`, a partial update wiped
  the fields it did not mention (a change to `principal_activity` emptied a
  company's `directors`, taking the register link with it). The body is now
  merged over the stored row.

### Notes

- `.env` now pins `IMAGE_TAG` and `SKIP_AI_TRAINING`. Both previously existed
  only on the running container, so a plain recreate reverted to `scout:latest`
  with template analysis silently disabled.

## [1.2.6] — 2026-08-24

### Fixed

- **PDF preview: the version mismatch was a browser extension, not the cache.**
  Measured in the live page: `globalThis.pdfjsLib` is present at 5.2.133 with a
  matching `globalThis.pdfjsWorker`, injected by an extension — there are no
  foreign script tags. pdf.js reuses an existing global `WorkerMessageHandler`
  rather than loading its own worker, so the bundled 4.0.379 API was driving the
  extension's 5.2.133 worker. The viewer now constructs its own module Worker
  and passes it as `workerPort`, bypassing the global lookup entirely, and
  terminates it on unmount. The URL-versioning and cache work in 1.2.1–1.2.5 was
  sound hygiene but addressed the wrong cause; the earlier diagnosis was wrong.

## [1.2.5] — 2026-08-24

### Fixed

- **The PDF preview now repairs a poisoned worker cache instead of reporting an
  error.** Keying the worker URL to the library version (1.2.1) stops a stale
  entry being matched, but cannot help a browser already holding one for the
  path an older bundle requested. On a version mismatch the viewer now refetches
  the worker with `cache: 'reload'` and hands pdf.js a blob URL, which has no
  cache entry by construction. Retried exactly once — a second failure surfaces
  rather than looping.

## [1.2.4] — 2026-08-24

### Fixed

- **Hashed JS and CSS were never cached.** 1.2.3 added an `immutable` branch for
  `_next/static/*`, but `app.mount("/_next", StaticFiles(...))` answers every
  one of those requests before the catch-all is reached, and StaticFiles sends
  no `Cache-Control` at all — so the branch was dead code for exactly the assets
  it existed for. The biggest, most cacheable files in the app were re-fetched
  on every load. The header now sits on the mount that actually serves them.
  Caught by curling a live container; the offline test had asserted only that a
  string appeared in the source, which cannot see which code path runs.

## [1.2.3] — 2026-08-24

### Added

- **The version number in the rail opens the changelog.** Click it for a
  "What's new" panel listing every release, newest first, with the version the
  SERVER is actually running badged as such — the API and the frontend can come
  from different images, and this is the only place that difference shows.
  Parsed by `GET /api/changelog` so no markdown library ships in the bundle,
  and registered above the frontend catch-all, where a GET would otherwise
  answer 200 with the frontend's HTML and never run.
- `tests/tracker_assets.py` grew to 18 checks / 5 controls, including one that
  moves the changelog route below the catch-all and proves the guard catches it.

## [1.2.2] — 2026-08-24

### Fixed

- **The sidebar showed a hardcoded "v2".** `AppRail.tsx` carried
  `const APP_VERSION = 'v2'`, which had not moved through five releases, so
  nothing in the interface told you which build you were on. It now reads
  `GET /api/version`, which serves the real `/VERSION` file — the SERVER's
  version, not one compiled into the bundle, since the two can differ. Fails
  quiet: on error the label reads "Legal Scout" rather than a wrong number.

## [1.2.1] — 2026-08-24

### Fixed

- **Training re-analysed every template on disk, not the ones you uploaded.**
  The job's final step POSTed `/api/knowledge/deep-train` with no body, and that
  endpoint globs the whole templates directory. Uploading **2** templates
  registered **15** rows and ran ~11 minutes of AI work, re-adding files that had
  deliberately been removed from the register. The job now sends its own queue
  and the endpoint honours it.
- **The UI looked hung at 100%.** Nothing updated the job row during the
  deep-train phase, so the client polled an unchanging row for ~11 minutes after
  the per-template bar had already reached "2 of 2". The phase now reports
  itself. It is still one blocking call — that is the next thing to fix if the
  template count grows.
- **pdf.js "API version does not match the Worker version".** The worker was
  requested from a fixed path with no `Cache-Control` anywhere in static
  serving, on a port that hosts a different app every few weeks — so a browser
  could hand pdf.js a worker cached from an unrelated app (reported 5.2.133)
  while the server served 4.0.379 throughout. The worker URL is now keyed to the
  library's own version, `_next/static/*` is `immutable`, and everything else
  revalidates against its existing ETag.

### Added

- `tests/tracker_assets.py` — 10 checks, 3 controls. Fails the moment the
  committed `pdf.worker.min.mjs` drifts from the pinned `pdfjs-dist`, instead of
  waiting for someone to open a PDF.

## [1.2.0] — 2026-08-24

Three security fixes, one silent data-loss fix, a dead route, and a deterministic
test layer. Six new tables land unused: every new subsystem is flag-gated, default
OFF, with zero call sites in product code.

### Security

- **Cross-client leak in the agent's `search_knowledge` tool.** The query had no
  `source_file` restriction, and `add_company()` writes six identifying rows per
  client under `company:<name>` — so any substring match could return another
  client's registered office, directors and registration number. Measured before
  the fix: a search for a street name shared by two clients exposed **2 of 2**;
  after, **0**, with template knowledge still reachable. Admin search opts back in
  explicitly and now requires admin.
- **`DELETE /api/dashboard/company/{name}` could delete every company.** `ILIKE` on
  the raw path parameter with no `LIMIT`, and `autocommit = True` set two lines
  above, so no transaction to roll back. `%25` in the path unquoted to `%` and
  matched all rows; a registered name containing `_` silently took siblings with
  it. Now `lower(...) = lower(%s)`; the `knowledge_lookup` sweep stays a LIKE but
  escapes its parameter.
- **`cessation_recorded_by` is stamped from the session**, never from the request
  body. A forged recorder in the payload is ignored.

### Fixed

- **`link_company_person` NULLed every field the caller omitted.** Already firing
  in production: the "Link company" form never sends `share_class`, so re-linking
  someone to correct a date silently cleared their share class. Fields absent from
  the body now keep their stored value; a field present but empty still clears.
- **A dead API route answering HTTP 200.** `/api/company/generate-extract/{id}` was
  registered below the frontend catch-all, so it returned the frontend's HTML —
  byte-identical to a path that does not exist. Moved above it.
- **Two different functions registered under one agno tool name** (`list_sources`,
  in `awareness.py` and `knowledge_tools.py`). One was unreachable. Renamed, and
  the boot now refuses to start on any duplicate — the previous guards all worked
  from a `set`, which collapsed the collision and could never raise.
- **Party slots asked once for N positions.** `collect_slot_requests` collapsed
  every numbered position of a party family into a single question: 7 real
  directors produced **1** ask, not 7. It now consults the same source the
  document expander does. An unknown party count deliberately keeps the old
  behaviour rather than guessing.
- **`is_valid_entry` validated everything.** It coerced a `(bool, reason)` tuple
  with `bool()`, which is always `True`. Latent — no callers.
- Three modules were unimportable on Python 3.9 (`X | None` with no
  `from __future__ import annotations`).

### Added

- **Deterministic test layer.** `scout/testing/` drives the tracker suites with no
  model, network or container. `tracker_layer2` and `tracker_layer3` are now
  deterministic; the model-driven originals are preserved as `*_live.py`. New
  `tracker_fill.py`. Every suite carries negative controls that are executed on
  each run, and a control that fails to move the number fails the suite.
- **Routines** (`migration_022`) — document-production sequences as data, built on
  `legal_skills` rather than beside it. Flag `LEGAL_SCOUT_ROUTINES`.
- **Per-company memory** (`migration_023`, `026`) — the first company-scoped store
  in the product; scope is a `NOT NULL` FK, not an optional filter. A write never
  proceeds on an ambiguous company. Flag `LEGAL_SCOUT_MEMORY`.
- **Effects ledger** (`migration_024`) — turn-scoped record of what an agent turn
  changed, with field-scoped before-images. Exceeding the size cap flips
  `reversible` to FALSE rather than advertising an undo it cannot perform. Writes
  on their own connection, never the caller's. Flag `SCOUT_EFFECTS_LEDGER`.
- **People cessation** (`migration_025`) — record why and by whom a director
  ceased, on `company_people` where `resigned_date` already lives.

### Known open

- Company scope in `knowledge_lookup` is a naming convention inside a string, not
  a key. 1.2.0 keeps the client namespace away from the agent; it does not add the
  scope column.
- `scout_learnings` is keyed by `user_id` only, while the prompt asks the model to
  save company-specific facts into it.
- Nothing calls the routines, memory or effects layers yet. The tables exist and
  are empty.
