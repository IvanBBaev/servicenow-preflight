// StoryResolver — ARCH-5's first source: "what did this story change?"
//
// Three reads, in one direction only:
//
//   rm_story        the one story the caller named
//   sys_update_set  the update sets linked to that story
//   sys_update_xml  the rows those update sets carry
//
// The shape of this file is mostly the consequence of refusing to let any of
// the three fail quietly. A story number is the one input a human types by
// hand, so "no such story" has to be a statement the user can act on
// (ResolutionInputError), while a read that never happened has to stay an
// infrastructure fault (ResolutionFaultError) — the DEV-1 line. And a query
// the instance REFUSED must never come back as an empty artifact list, because
// downstream an empty list is indistinguishable from "this story changed
// nothing", which is the silent green QA-9 forbids.
//
// TM-1: the reads below take IDENTITY only — sys_id, number, an update-set
// name, a member's target name. A story's `short_description`, an update set's
// description and any script body are untrusted free text the threat model
// requires branded at ingestion, and this stage has no use for them: it
// answers "which records changed", not "what do they say". Adding a field to
// one of the projections below is not a widening of a projection, it is a
// widening of the trust boundary.
//
// KNOWN GAP, for the live-verification pass. `sys_update_set.story` is the one
// ServiceNow schema assumption in this package that has NOT been confirmed
// against a live instance: the project's PDI credentials are dead (TODO.md),
// so the field name comes from documentation rather than from a query that
// returned rows. That is exactly why it is an option with a documented default
// instead of a literal, and why an unreadable update-set read throws instead
// of returning `[]` — an instance that links stories through some other field
// rejects this query with a 400, and the only wrong answer available at that
// moment is a clean empty one. Verify the field live; the option stays either
// way, only this paragraph goes.

import type {
  AffectedArtifact,
  PipelineContext,
  ResolverSource,
  TargetArtifactRef,
  TargetInput,
} from "@tessera/types";

import { ResolutionFaultError, ResolutionInputError } from "./errors.js";
import {
  artifactKey,
  assertQueryValue,
  isFieldName,
  isSysId,
  isTableName,
} from "./keys.js";
import { describeReadTruncation } from "./read.js";
import type { RecordReader, SnRecord, TableRead } from "./read.js";
import { completeArtifacts } from "./types.js";
import type {
  ResolutionLevel,
  ResolutionNote,
  ResolutionReport,
  SourceResolver,
} from "./types.js";

const SOURCE: ResolverSource = "story";

/** The `sys_update_set` field that points at `rm_story`. See KNOWN GAP above. */
export const DEFAULT_UPDATE_SET_STORY_FIELD = "story";

export interface StoryResolverOptions {
  /**
   * The `sys_update_set` field that references `rm_story`. Override it on an
   * instance whose Agile integration links the two some other way — the
   * default is documented, not verified (see the KNOWN GAP note above).
   */
  readonly updateSetStoryField?: string;
}

/** How many offending members a single note is allowed to list by name. */
const NAMES_PER_NOTE = 3;

function note(level: ResolutionLevel, message: string): ResolutionNote {
  return { source: SOURCE, level, message };
}

/**
 * Every field of a Table API row is a string when it is there at all; anything
 * else means the projection did not come back the way it was asked for, and an
 * absent field reads as empty rather than as `undefined` leaking downstream.
 */
function text(record: SnRecord, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `sys_update_xml.name` is `<table>_<32-hex sys_id>` — the only place a member
 * row states WHICH record it carries in a form this stage can address. The
 * table half is greedy on purpose: table names contain underscores
 * (`sys_script_include_<sysid>`), so only the trailing 32 hex characters can
 * be pinned. Returns `undefined` for the many real members that do not follow
 * the convention at all (dictionary entries, choice lists, relationship rows).
 */
export function parseUpdateXmlName(
  name: string,
): { table: string; sysId: string } | undefined {
  const match = /^(.+)_([0-9a-f]{32})$/.exec(name);
  if (match === null) return undefined;
  const [, table, sysId] = match;
  if (table === undefined || sysId === undefined) return undefined;
  // Delegated decision 2026-09-26 (L4): the table half becomes the `table` of
  // every downstream read, so it must be a plain table name. A member name
  // like `x^NQactive=true_<sysid>` or `Sys_Script_<sysid>` is not one, and is
  // reported as unaddressable (a warning) rather than addressed.
  if (!isTableName(table)) return undefined;
  return { table, sysId };
}

interface StoryRow {
  readonly sysId: string;
  /** What a human called it — the story number when the row carries one. */
  readonly label: string;
}

/**
 * One read of `rm_story`, identity fields only (TM-1). `limit: 2` rather than
 * `1`: the point of the read is to prove the caller named EXACTLY one story,
 * and a limit of one turns an ambiguous number into a confident wrong answer.
 */
async function findStory(
  reader: RecordReader,
  ctx: PipelineContext,
  wanted: string,
): Promise<StoryRow> {
  // A 32-hex argument can only be a sys_id, and querying `number=<sys_id>`
  // would answer "no such story" for a story that is right there.
  const field = isSysId(wanted) ? "sys_id" : "number";
  assertQueryValue(wanted, "the story");
  const read = await reader.queryRecords({
    table: "rm_story",
    query: `${field}=${wanted}`,
    fields: ["sys_id", "number"],
    // Delegated decision 2026-10-01 (wave 17): no Stats count here. This is
    // one page of at most two rows proving "exactly one story", not an
    // enumeration; zero rows is already refused as an input error that names
    // ACL trimming, and `crossCheckCount` only acts on a `fetchAll` read.
    limit: 2,
    signal: ctx.signal,
  });

  if (read.outcome === "undecidable") {
    throw new ResolutionFaultError(
      `could not read rm_story to find the story \`${wanted}\`: ${read.detail}`,
    );
  }
  if (read.records.length === 0) {
    throw new ResolutionInputError(
      `no rm_story matches \`${field}=${wanted}\` on ${reader.profile} — ` +
        `the instance answered, and there is no such story this profile can ` +
        `read: either nothing matches, or a matching row is trimmed from ` +
        `this caller by an ACL`,
    );
  }
  if (read.records.length > 1) {
    throw new ResolutionInputError(
      `\`${field}=${wanted}\` matches more than one rm_story on ` +
        `${reader.profile}; name the story by sys_id so the run tests the ` +
        `changes of exactly one story`,
    );
  }

  const row = read.records[0];
  const sysId = row === undefined ? "" : text(row, "sys_id");
  if (sysId === "") {
    // The row came back without the identity it was asked for, so nothing was
    // established about the story — an absence of evidence, not a verdict.
    throw new ResolutionFaultError(
      `rm_story answered \`${field}=${wanted}\` with a row that carries no ` +
        `sys_id, so the story could not be identified: ${read.detail}`,
    );
  }
  const number = row === undefined ? "" : text(row, "number");
  // Delegated decision 2026-09-25: the row must be the story that was NAMED,
  // not merely one the query matched. The Table API may match looser than
  // byte equality (case-insensitive collation, operator quirks), and a query
  // that answered about another story would test that story's changes under
  // this one's name. A row that fails the check is treated as no match at all
  // — the instance did not show the named story (fail closed).
  if ((field === "sys_id" ? sysId : number) !== wanted) {
    throw new ResolutionInputError(
      `no rm_story matches \`${field}=${wanted}\` exactly on ${reader.profile} — ` +
        `the instance answered with ${field === "sys_id" ? `sys_id \`${sysId}\`` : `number \`${number}\``}, ` +
        `which is not the story that was named`,
    );
  }
  if (!isSysId(sysId)) {
    // Delegated decision 2026-09-25: the sys_id is interpolated into the next
    // query, so a value that is not shaped like one is not an address.
    throw new ResolutionFaultError(
      `rm_story answered \`${field}=${wanted}\` with a sys_id that is not ` +
        `32 lowercase hex characters (${JSON.stringify(sysId)}), so the story ` +
        `could not be identified: ${read.detail}`,
    );
  }
  return { sysId, label: number === "" ? sysId : number };
}

/** The linked update sets, or a throw if the instance would not say. */
async function findUpdateSets(
  reader: RecordReader,
  ctx: PipelineContext,
  story: StoryRow,
  storyField: string,
): Promise<TableRead> {
  const read = await reader.queryRecords({
    table: "sys_update_set",
    query: `${storyField}=${story.sysId}^ORDERBYsys_id`,
    // The link field is read back so every row can be checked against the
    // filter that asked for it (M2, below).
    fields: ["sys_id", "name", storyField],
    fetchAll: true,
    // Delegated decision 2026-10-01 (wave 17): this read decides the
    // inventory, so it confirms its end with one Stats API count when the
    // instance sends no X-Total-Count. Without it, read ACLs trimming the
    // LAST window read as the end of results and a partial list passed as
    // the whole one (fail open). The cost is one extra GET, and only on a
    // header-less read that otherwise looked complete.
    crossCheckCount: true,
    signal: ctx.signal,
  });
  if (read.outcome !== "undecidable") {
    // Delegated decision 2026-09-26 (M2): every returned row must carry the
    // story it was asked for. The Table API silently IGNORES a condition on a
    // field it does not recognise and answers as if unfiltered, so without
    // this check a wrong `updateSetStoryField` would enumerate every update
    // set on the instance as this story's. A row that does not carry the
    // field at all is treated as a mismatch (fail closed): it cannot prove it
    // belongs here.
    const foreign = read.records.filter(
      (row) => text(row, storyField) !== story.sysId,
    );
    if (foreign.length > 0) {
      throw new ResolutionFaultError(
        `the update-set read for ${story.label} returned ${foreign.length} ` +
          `row(s) whose \`${storyField}\` is not ${story.sysId} — the ` +
          `instance did not apply the filter it was sent (an unrecognised ` +
          `\`updateSetStoryField\` is ignored rather than refused), so none ` +
          `of the answer can be trusted`,
      );
    }
    return read;
  }

  // THE load-bearing honesty rule of this file (the OPP-1b lesson). An
  // instance that links stories to update sets through a different field
  // rejects this query with a 400 — the instance refused the QUESTION, which
  // is not the same fact as "the story has no update sets", even though the
  // Table API renders both as zero rows. Returning `[]` here would turn a
  // misconfiguration into a green run that tested nothing, so the read that
  // did not happen is raised as a fault and names the knob that fixes it.
  throw new ResolutionFaultError(
    `could not read the update sets linked to ${story.label}: ` +
      `${read.detail}. The link was queried as ` +
      `\`sys_update_set.${storyField}\`; if this instance stores it on ` +
      `another field the query is rejected rather than answered, which is ` +
      `NOT the same as "this story has no update sets" — set ` +
      `\`updateSetStoryField\` to the field this instance actually uses.`,
  );
}

/** The rows those update sets carry, or a throw if the instance would not say. */
async function findMembers(
  reader: RecordReader,
  ctx: PipelineContext,
  story: StoryRow,
  updateSetIds: readonly string[],
): Promise<TableRead> {
  const read = await reader.queryRecords({
    table: "sys_update_xml",
    query: `update_setIN${updateSetIds.join(",")}^ORDERBYsys_id`,
    // `name` addresses the changed record, `target_name` labels it, `action`
    // says whether it still exists to be tested, `type` and `sys_id` are what
    // a human needs to open the member row a note complains about, and
    // `update_set` says which of the story's sets contributed it. Nothing
    // here is prose (TM-1).
    fields: ["sys_id", "name", "type", "target_name", "action", "update_set"],
    fetchAll: true,
    // Delegated decision 2026-10-01 (wave 17): this read decides the
    // inventory, so it confirms its end with one Stats API count when the
    // instance sends no X-Total-Count. Without it, read ACLs trimming the
    // LAST window read as the end of results and a partial list passed as
    // the whole one (fail open). The cost is one extra GET, and only on a
    // header-less read that otherwise looked complete.
    crossCheckCount: true,
    signal: ctx.signal,
  });
  if (read.outcome !== "undecidable") {
    // Delegated decision 2026-09-26 (M2): every member row must belong to one
    // of the update sets the IN list named — checked on EVERY row, deletions
    // included, before anything is skipped or counted. A row from any other
    // set means the filter was not applied, and the whole answer is suspect.
    const asked = new Set(updateSetIds);
    const foreign = read.records.filter(
      (row) => !asked.has(text(row, "update_set")),
    );
    if (foreign.length > 0) {
      throw new ResolutionFaultError(
        `the member read for ${story.label} returned ${foreign.length} ` +
          `row(s) whose \`update_set\` is not one of the ` +
          `${updateSetIds.length} set(s) asked for — the instance did not ` +
          `apply the filter it was sent, so none of the answer can be trusted`,
      );
    }
    return read;
  }

  throw new ResolutionFaultError(
    `could not read the members of ${updateSetIds.length} update set(s) ` +
      `linked to ${story.label}: ${read.detail}`,
  );
}

/** `<name> (<type>, sys_update_xml/<sys_id>)` — enough to open the row. */
function describeMember(row: SnRecord, name: string): string {
  const type = text(row, "type");
  const sysId = text(row, "sys_id");
  // A member row that came back without its own sys_id has no address, and
  // `sys_update_xml/` printed in the grammar of one sends a reader looking up
  // a row nobody named. Say that the address is missing instead.
  const where =
    sysId === ""
      ? "no readable sys_update_xml sys_id"
      : `sys_update_xml/${sysId}`;
  return `\`${name}\` (${type === "" ? where : `${type}, ${where}`})`;
}

function list(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_PER_NOTE);
  return names.length > shown.length
    ? `${shown.join(", ")} and ${names.length - shown.length} more`
    : shown.join(", ");
}

export function createStoryResolver(
  reader: RecordReader,
  options: StoryResolverOptions = {},
): SourceResolver {
  const storyField =
    options.updateSetStoryField ?? DEFAULT_UPDATE_SET_STORY_FIELD;
  // Delegated decision 2026-09-25: `updateSetStoryField` becomes the left side
  // of a query condition, so it must be a field name and nothing else; checked
  // per resolve (below) so the refusal travels the input-error path.
  const storyFieldOk = isFieldName(storyField);

  const resolveWithReport = async (
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<ResolutionReport> => {
    const notes: ResolutionNote[] = [];

    if (input.story === undefined) {
      // Nothing was asked, so nothing is missing — and nothing is read. This
      // is `info`, not `warning`: the composite runs every source on every
      // input, and a source that was not addressed does not make the union
      // incomplete.
      notes.push(
        note("info", "no story was named, so this source contributed nothing"),
      );
      return { artifacts: [], notes };
    }
    const wanted = input.story.trim();
    if (wanted === "") {
      // The flag was typed and left empty. Querying `number=` would ask the
      // instance a question with no subject; the fix is a different argument.
      throw new ResolutionInputError(
        "a story was named but the value is blank; pass a story number " +
          "(STRY0042) or a 32-character sys_id",
      );
    }

    if (!storyFieldOk) {
      throw new ResolutionInputError(
        `updateSetStoryField ${JSON.stringify(storyField)} is not a field ` +
          `name (lowercase letters, digits, underscores, optional dot-walk), ` +
          `so no query was sent`,
      );
    }

    const story = await findStory(reader, ctx, wanted);

    const setsRead = await findUpdateSets(reader, ctx, story, storyField);
    if (setsRead.truncated) {
      // Delegated decision 2026-09-26: "truncated at the read cap" was only
      // one of three partial cases (see `TableRead.truncationReason`); the
      // clause now names the actual one. The warning itself — and so the
      // incomplete verdict — is unchanged.
      notes.push(
        note(
          "warning",
          `the list of update sets linked to ${story.label} ` +
            `${describeReadTruncation(setsRead)}, so this story may carry ` +
            `update sets nobody below has looked at: ${setsRead.detail}`,
        ),
      );
    }
    const linkedSets = setsRead.records.length;
    const updateSetIds = setsRead.records
      .map((row) => text(row, "sys_id"))
      // Delegated decision 2026-09-25: only a well-formed sys_id is an
      // address. These ids are joined into an `IN` list, so a value carrying
      // `,` or `^` would widen the member query; anything not shaped like a
      // sys_id is counted as unaddressable, exactly like a blank one.
      .filter((sysId) => isSysId(sysId));
    // A row whose `sys_id` came back blank — field-level ACL trimming renders
    // exactly that way — cannot be queried for members, so everything it
    // changed is missing from the artifacts below. Dropping it silently made
    // the count that follows describe the sets this filter kept while reading
    // as the sets the story has.
    const unaddressableSets = linkedSets - updateSetIds.length;
    if (updateSetIds.length === 0) {
      // A legitimate state — and still not a green answer. The caller asked
      // "what changed?", so the honest reply is "nothing is linked to this
      // story", said loudly enough that a run cannot pass by testing nothing.
      notes.push(
        note(
          "warning",
          linkedSets === 0
            ? `${story.label} has no update sets linked through ` +
                `\`sys_update_set.${storyField}\`, so this source found ` +
                `nothing to test. Either the work is not in an update set ` +
                `yet, this instance links stories through another field ` +
                `(\`updateSetStoryField\`), or the sets that do exist are ` +
                `trimmed from this profile by an ACL.`
            : `all ${linkedSets} update set(s) linked to ${story.label} came ` +
                `back without a readable sys_id, so none of them could be ` +
                `enumerated and this source found nothing to test — which ` +
                `is not the same as the story having no update sets.`,
        ),
      );
      return { artifacts: [], notes };
    }
    if (unaddressableSets > 0) {
      notes.push(
        note(
          "warning",
          `${unaddressableSets} of the ${linkedSets} update set(s) linked to ` +
            `${story.label} came back without a readable sys_id, so their ` +
            `members were never read and the artifacts below are missing ` +
            `whatever those sets changed`,
        ),
      );
    }

    const membersRead = await findMembers(reader, ctx, story, updateSetIds);
    if (membersRead.truncated) {
      notes.push(
        note(
          "warning",
          // Delegated decision 2026-09-26: same rewording as the set list
          // above — the reason is named, the warning is unchanged.
          `the member list of ${story.label}'s update sets ` +
            `${describeReadTruncation(membersRead)}, so the artifacts below ` +
            `are a partial picture of what this story changed: ` +
            `${membersRead.detail}`,
        ),
      );
    }

    const artifacts: AffectedArtifact[] = [];
    const seen = new Set<string>();
    const contributing = new Set<string>();
    const unaddressable: string[] = [];
    let deleted = 0;
    let duplicates = 0;

    for (const row of membersRead.records) {
      const from = text(row, "update_set");
      if (from !== "") contributing.add(from);
      // An update set that DELETES a record leaves nothing on the target to
      // execute, so a test generated against it could only ever fail for the
      // wrong reason. Counted, not silently dropped.
      if (text(row, "action").toUpperCase() === "DELETE") {
        deleted += 1;
        continue;
      }
      const name = text(row, "name");
      const parsed = parseUpdateXmlName(name);
      if (parsed === undefined) {
        unaddressable.push(describeMember(row, name));
        continue;
      }
      // `target_name` is the display name the update set recorded; without
      // one, a table/sys_id label still points a human at the right row.
      const label = text(row, "target_name");
      const ref: TargetArtifactRef = {
        table: parsed.table,
        sysId: parsed.sysId,
        name: label === "" ? `${parsed.table}/${parsed.sysId}` : label,
      };
      const key = artifactKey(ref);
      // The same record lands in several update sets whenever a story is
      // delivered in more than one pass; first-seen order keeps the report
      // stable and matches the order the instance returned.
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      artifacts.push({ ref, resolvedBy: SOURCE });
    }

    if (deleted > 0) {
      notes.push(
        note(
          "info",
          `${deleted} member(s) delete a record and were skipped — an ` +
            `artifact the update set removes cannot be tested`,
        ),
      );
    }
    if (unaddressable.length > 0) {
      // A member nobody can address is a member nobody can test, and it is
      // invisible in the artifact list unless something says so here.
      notes.push(
        note(
          "warning",
          `${unaddressable.length} update-set member(s) carry a name that is ` +
            `not \`<table>_<sys_id>\`, so the record they changed cannot be ` +
            `addressed and they were skipped: ${list(unaddressable)}`,
        ),
      );
    }
    if (duplicates > 0) {
      notes.push(
        note(
          "info",
          `${duplicates} duplicate member(s) collapsed — the same record ` +
            `appears in more than one of ${story.label}'s update sets`,
        ),
      );
    }
    notes.push(
      note(
        "info",
        `${story.label}: ${updateSetIds.length} update set(s) linked ` +
          `(${contributing.size} contributed members), ` +
          `${membersRead.records.length} member(s) read, ` +
          `${artifacts.length} artifact(s)`,
      ),
    );

    return { artifacts, notes };
  };

  return {
    source: SOURCE,
    resolveWithReport,
    async resolve(ctx: PipelineContext, input: TargetInput) {
      // The port has no channel for notes, so a complete report's artifacts
      // come back unchanged and an incomplete one throws (H1, see
      // `completeArtifacts`).
      return completeArtifacts(await resolveWithReport(ctx, input), "story");
    },
  };
}
