# Letter Writing Guide

You've never written a letter? Good news: every business letter in the
world follows the same simple anatomy, and this template already has
all the parts. This guide explains what each part is for, what varies
between countries, and what is actually universal.

---

## The anatomy of a letter

| # | Part | Purpose | In this template |
|---|------|---------|------------------|
| 1 | **Letterhead** | Who the letter is from — name, address, contact | Top of page 1, automatic |
| 2 | **Date** | When it was written | `\LetterDate` (defaults to today) |
| 3 | **Reference lines** *(optional)* | File/case numbers so both sides can match letters to a case | `\OurReference`, `\YourReference` |
| 4 | **Recipient block** | Who it is for, and where | `\RecipientName`, `\RecipientDetails` |
| 5 | **Subject line** | What it is about, at a glance | `\SubjectPrefix` + `\LetterSubject` |
| 6 | **Salutation** | The greeting | Written directly in the body |
| 7 | **Body** | The message itself | Written directly in the body |
| 8 | **Complimentary close** | The sign-off before your signature | Written directly in the body |
| 9 | **Footnotes** *(optional)* | Enclosed documents, copies to others | `\Enclosures{...}`, `\CopiesTo{...}` |

If a letter has all of 1–8, it is a complete letter anywhere in the
world. Everything else is local flavour.

---

## "Re:" and the subject line

**"Re:" is Latin, short for *in re* — "in the matter of".** It marks the
subject: what the letter is about. It is the paper-era ancestor of the
email subject field (in email, "Re:" was reinterpreted as "reply", but
it is the same Latin root).

`Re: Proposal for Collaboration` tells the recipient — and anyone
filing or forwarding the letter — the topic before they read a word.

The prefix differs by country:

| Language | Prefix |
|----------|--------|
| English  | `Re:` (often dropped entirely — a bold subject alone is fine) |
| Swedish  | `Ärende:` |
| German   | `Betreff:` |
| French   | `Objet :` |
| US usage | `RE:` or `SUBJECT:` in caps, often without a colon |

In this template the prefix is the variable `\SubjectPrefix`. Set it to
`Re:`, `Ärende:`, `Betreff:`, or leave it empty `{}` — an empty prefix
removes the prefix *and* its spacing, leaving just the bold subject.

---

## US vs. Europe — what actually differs

There is **no international standard** for private letters. A few
countries even have official rules for public/authority mail (Germany's
DIN 5008, Sweden's *Myndigheternas skrivregler*), but business letters
everywhere are convention, not law. The common differences:

| Element | US convention | UK/EU convention |
|---------|---------------|------------------|
| Date format | August 24, 2026 | 24 August 2026 |
| Date position | Left, above recipient | Right or left — varies |
| Reference lines | Rare — legal/government mail only | Common in business mail |
| Subject prefix | `RE:` / `SUBJECT:` | `Re:` or no prefix |
| Closing | `Sincerely,` almost always | See the sincere/faithful rule below |

**The UK closing rule** (often quoted, occasionally even followed):
- You addressed the recipient **by name** ("Dear Ms. Jones") →
  **Yours sincerely**
- You addressed them **impersonally** ("Dear Sir or Madam") →
  **Yours faithfully**

US practice ignores this distinction and uses `Sincerely,` throughout.
Swedish letters commonly end with *Med vänliga hälsningar* ("With kind
regards"), which maps well to `Kind regards,` in English — slightly
warmer than "Yours sincerely", fine in most business contexts.

---

## The universal part

No standard, yes — but all business letters worldwide share the same
**logic**: *who → to whom → about what → the message → who signed it.*
Follow these habits and your letter will read professionally anywhere:

1. **State your purpose in the first paragraph.** Busy readers decide
   in seconds whether a letter matters.
2. **One idea per paragraph**, separated by a blank line (the template's
   block style — no indents).
3. **End with the action you want**: "I look forward to hearing from
   you", "Please confirm by…". A letter without a requested next step
   usually gets none.
4. **Match formality to the relationship**, not to tradition. "Dear
   Mr. Surname" is always safe; "Hi Firstname" only once they've gone
   first.
5. **When in doubt, follow the recipient's local convention** — and a
   bolded subject line is never wrong anywhere, whatever prefix you use.

---

## Quick glossary

- **Salutation** — the greeting line ("Dear Mr. Whitfield,").
- **Complimentary close** — the sign-off ("Yours sincerely,") above the
  signature.
- **Enclosure (Encl.:)** — a document physically *enclosed* with the
  letter (or attached to the email carrying it). Lists what else is in
  the envelope so the recipient can check nothing was lost.
- **cc:** — "carbon copy", from the typewriter era. People who receive
  a copy for their information, even though the letter is addressed to
  someone else. (Today email inherited the term verbatim.)
- **Our ref / Your ref** — file or case numbers. "Our ref" is the
  number *your* organisation files the letter under; "Your ref" quotes
  *their* number so they can connect it to their case. Purely practical
  — skip both if nobody gave you a reference.
