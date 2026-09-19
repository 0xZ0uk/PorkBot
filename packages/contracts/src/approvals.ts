import { APPROVAL_STATUSES } from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The operator's approval surface (slice 10.3, PRD story 40).
 *
 * The list is deliberately the durable row rather than a projection of the
 * event stream: a reload can still show a pending request, and history keeps
 * the redacted arguments that explain what was approved. `botId` and
 * `threadId` are the run relationships the console needs for filtering and
 * its deep link.
 */

export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export const approvalVoteSchema = z.enum(["approve", "deny"]);

export const approvalSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1),
  /** Redacted at the gate before it reaches durable storage. */
  arguments: z.unknown(),
  status: approvalStatusSchema,
  expiresAt: z.iso.datetime(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});

export type Approval = z.infer<typeof approvalSchema>;

const approvalFilters = z.object({
  botId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  status: approvalStatusSchema.optional(),
});

export const approvalsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/approvals",
    operationId: "approvalsList",
    summary: "List pending and historical approvals with optional bot or run filters",
  })
  .input(approvalFilters)
  .output(z.object({ approvals: z.array(approvalSchema) }));

export const approvalsDecideContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/approvals/{runId}/{callId}",
    operationId: "approvalsDecide",
    summary: "Approve or deny one pending dangerous action",
  })
  .input(
    z.object({
      runId: z.string().min(1),
      callId: z.string().min(1),
      vote: approvalVoteSchema,
      reason: z.string().max(2_000).optional(),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such approval in this space",
    },
  })
  .output(
    z.object({
      approval: approvalSchema,
      /** False when this request observed a decision that already won a race. */
      applied: z.boolean(),
    }),
  );
