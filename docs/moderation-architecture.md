# Moderation Architecture

This bot keeps moderation decisions in layers. The goal is to make each new real-world lesson land in the smallest layer that owns it.

## Layers

1. Intake and scope

Resolve identity, group membership, command status, muted users, bans, and configured group scope before content moderation runs.

2. Classifiers

Classifiers answer "what does this message look like?" They should avoid side effects and return structured evidence. For ticket marketplace moderation, this is `classify()` in `src/moderation/ticketMarketplace/classifier.ts`.

3. Decisions

Decision modules answer "what should we do in this context?" They combine classifier output with group, config, confidence, and domain rules. For ticket marketplace moderation, this is `getTicketMarketplaceDecision()` in `src/moderation/ticketMarketplace/index.ts`.

4. Actions

Actions reply, delete, strike, queue review, queue spotlight, cancel spotlight, or log. These live in orchestration code such as `src/index.ts` and command handlers.

5. Review

Ambiguous or medium-confidence cases should be soft-flagged into `review_queue` instead of becoming automatic deletion when the cost of a false positive is high.

6. Automation

Delayed or recurring work belongs in schedulers and stores: spotlight scheduling, rule reminders, and announcements.

7. Audit and observability

Every enforcement action should leave a reason trail through audit logs, deletion logs, review rows, or structured logger events.

## Where New Knowledge Goes

False positive phrase: classifier exemption or classifier regression fixture.

Correct classification but wrong outcome: decision layer.

Needs human judgment: review layer.

Needs repeated, delayed, or scheduled work: automation layer.

Needs user or admin control: commands layer.

Needs traceability or safety evidence: audit layer.

## Regression Rule

Every false positive or false negative that we learn from production should get a regression test at the same layer where it is fixed.

Classifier fixes belong in `src/moderation/ticketMarketplace/__tests__/fixtures.ts` when they are reusable examples. One-off structural behavior can live in the closest test file.

Routing fixes belong in `src/moderation/ticketMarketplace/__tests__/routing.test.ts`.

Action, queue, and scheduler fixes belong in their matching store, sender, scheduler, or integration-style test.

## Debugging

Use `!explain` when a moderation result is surprising.

In a group, reply to a message with `!explain` to inspect the ticket marketplace classifier and routing decision in that group's context.

In DM, use `!explain {text}` to inspect the default ticket marketplace context, or `!explain {groupJid} {text}` to force a specific group context.

The output should include action, reason, intent, confidence, price status, matched tokens, buy signals, sell signals, and dominance. If a false positive or false negative is confirmed, add a regression fixture at the layer where the fix is made.

## Current Ticket Marketplace Contract

The ticket marketplace classifier returns:

- `intent`: `none`, `buying`, or `selling`
- `confidence`: `low`, `medium`, or `high`
- `matchedTokens`: user-readable signal snippets
- `matchedSignals`: buy and sell signal groups plus dominance
- `hasPrice`: whether a valid price is present for the inferred intent

The decision layer returns actions:

- `allow`
- `redirect_buying`
- `redirect_selling`
- `require_price`
- `review`

Low-confidence support language should be allowed. Medium-confidence resale-like content outside the marketplace should go to review. High-confidence marketplace violations can be redirected or enforced automatically.

## Guardrail

Do not add a new top-level moderation system for every new phrase. First ask which layer owns the behavior. This keeps the bot intelligent without turning the classifier into a pile of unrelated patches.
