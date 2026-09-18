import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * The deployment module: facts a client needs before it has a session.
 *
 * `deployment.status` answers "does this deployment accept signups?" so a
 * sign-in screen can decide whether to offer registration. It is deliberately
 * pre-auth: no actor exists before the gate runs, and the answer is not
 * tenant data (PRD decision 8, and slice 3.1's `readDeploymentSettings`, the
 * one read that takes no tenant id). Making a procedure public is meant to be
 * an explicit act once the gate lands in slice 3.2; this procedure is public
 * by construction and says so here.
 */

/** Fail-closed: only an explicit `signupsEnabled: true` reads as open. */
export const signupAvailabilitySchema = z.enum(["open", "closed"]);

export type SignupAvailability = z.infer<typeof signupAvailabilitySchema>;

export const deploymentStatusContract = oc
  .route({
    method: "GET",
    path: "/deployment/status",
    operationId: "deploymentStatus",
    summary: "Whether this deployment accepts signups",
  })
  .errors({
    /**
     * The settings table disagrees with itself: more than one row, so "are
     * signups open?" has no single answer. The service must not answer either
     * way, because "closed" would be a lie the UI repeats and "open" would
     * defeat fail-closed ownership. No data: the operator gets the detail in
     * the redacted server log, and a public caller learns only that the
     * question cannot be answered right now.
     */
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The deployment's signup configuration is not readable",
    },
  })
  .output(z.object({ signups: signupAvailabilitySchema }));
