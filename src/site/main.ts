// Import the functions you need from the SDKs you need
import { FirebaseOptions, initializeApp } from "firebase/app";
import {
  getDatabase,
  query,
  ref,
  orderByChild,
  set,
  remove,
  push,
  get,
  update,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  DataSnapshot,
} from "firebase/database";
import Quill, { DeltaOperation } from "quill";
import { Position, PositionSource } from "./position_source";

// Include CSS
import "quill/dist/quill.snow.css";

const Delta = Quill.import("delta");
declare type Delta = {
  ops: DeltaOperation[];
};

// DB type for reference.
interface DBType {
  text: {
    [key: string]: {
      /**
       * char comes from a Quill Delta's insert field, split
       * into single characters if a string.  So it is either
       * a single char, or (for an embed) a JSON-serializable
       * object with a single property.
       *
       * Except, Firebase conflict resolution can create an entry with
       * no char (undefined), if there is an attr set concurrent to deleting
       * the char; such chars are ignored.
       */
      char?: string | object;
      /**
       * CRDT position, from PositionSource.
       * Defined whenever char is defined.
       */
      pos?: Position;
      /**
       * Quill attributes.
       * RTDB sets this to undefined when it is empty ({}).
       */
      attrs?: {
        [attr: string]: any;
      };
    };
  };
}

(async function () {
  // Quill setup
  const quill = new Quill("#editor", {
    theme: "snow",
    // Modules list from quilljs example, via
    // https://github.com/KillerCodeMonkey/ngx-quill/issues/295#issuecomment-443268064
    // We remove syntax: true because I can't figure out how
    // to trick Webpack into importing highlight.js for
    // side-effects.
    // Same with "formula" (after "video") and katex.
    modules: {
      toolbar: [
        [{ font: [] }, { size: [] }],
        ["bold", "italic", "underline", "strike"],
        [{ color: [] }, { background: [] }],
        [{ script: "super" }, { script: "sub" }],
        [{ header: "1" }, { header: "2" }, "blockquote", "code-block"],
        [
          { list: "ordered" },
          { list: "bullet" },
          { indent: "-1" },
          { indent: "+1" },
        ],
        ["direction", { align: [] }],
        ["link", "image", "video"],
        ["clean"],
      ],
    },
  });
  quill.enable(false);

  /**
   * Returns the attributes object for the given index in Quill's current state.
   */
  function getQuillAttributes(index: number): { [attr: string]: any } {
    const delta = quill.getContents(index, 1);
    return delta.ops[0].attributes ?? {};
  }

  let inUpdateQuill = false;
  let inQuillListener = false;
  function updateQuill(delta: Delta) {
    // Skip updating Quill inside Quill's event listener, since Quill
    // is already updated.
    if (inQuillListener) return;

    inUpdateQuill = true;
    try {
      quill.updateContents(delta as any);
    } finally {
      inUpdateQuill = false;
    }
  }

  // Initialize Firebase
  const configEnv = process.env.FIREBASE_CONFIG;
  if (!configEnv) {
    throw new Error("FIREBASE_CONFIG not set");
  }
  const firebaseConfig = <FirebaseOptions>JSON.parse(configEnv);
  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  const textRef = ref(db, "text/");

  const posSource = new PositionSource();
  // The current text's sorted pos's and keys are cached in
  // positions and keys, resp.
  let positions: Position[] = [];
  let keys: string[] = [];

  const textQuery = query(textRef, orderByChild("pos"));

  // Reflect DB updates in Quill.
  // Unlike in firebase/text-editor, we listen for incremental events,
  // instead of rewriting the whole text each time; this is necessary for
  // Quill's cursors to work properly, and is more efficient besides.
  // Note that for local operations, Quill has already updated
  // its own representation, so updateQuill skips doing so again.
  let initialDataLoaded = false;
  onChildAdded(textQuery, (child, previousChildName) => {
    // Skip childAdded events for initial data (covered by get() below).
    if (!initialDataLoaded) return;

    const val = child.val();
    if (val.char === undefined) return;
    // OPT: do this in sublinear time.
    const index =
      previousChildName === null ? 0 : keys.indexOf(previousChildName!) + 1;

    keys.splice(index, 0, child.key!);
    positions.splice(index, 0, val.pos);
    updateQuill(new Delta().retain(index).insert(val.char, val.attrs));
  });
  onChildRemoved(textQuery, (child) => {
    const val = child.val();
    if (val.char === undefined) return;
    // OPT: do this in sublinear time.
    const index = keys.indexOf(child.key!);

    keys.splice(index, 1);
    positions.splice(index, 1);
    updateQuill(new Delta().retain(index).delete(1));
  });
  onChildChanged(textQuery, (child) => {
    // OPT: do this in sublinear time.
    const index = keys.indexOf(child.key!);
    const val = child.val();

    if (val.char === undefined) {
      // Child is removed.
      // If it's newly removed, delete it.
      // OPT: do this in sublinear time.
      if (index !== -1) {
        keys.splice(index, 1);
        positions.splice(index, 1);
        updateQuill(new Delta().retain(index).delete(1));
      }
      return;
    }
    // Need to set char's attributes to *exactly* attrs.
    // It's okay to rewrite existing attributes (redundantly),
    // but we must be careful to explicitly delete no-longer-existing
    // attributes, by setting them to null.
    const attrsWithDeletes = { ...val.attrs };
    const existingAttrs = getQuillAttributes(index);
    for (const key of Object.keys(existingAttrs)) {
      if (attrsWithDeletes[key] === undefined) {
        attrsWithDeletes[key] = null;
      }
    }

    updateQuill(new Delta().retain(index).retain(1, attrsWithDeletes));
  });

  // Load initial state and sync it to Quill.
  const initial = await new Promise<DataSnapshot>((resolve, reject) => {
    get(textQuery).then((snapshot) => {
      if (snapshot.exists()) resolve(snapshot);
      else reject("No initial data");
    });
  });
  const initialOps: any[] = [];
  initial.forEach((child) => {
    const val = child.val();
    if (val.char === undefined) return;
    keys.push(child.key!);
    positions.push(val.pos);
    initialOps.push({ insert: val.char, attributes: val.attrs });
  });
  updateQuill(
    new Delta({
      ops: initialOps,
    })
  );
  // Delete Quill's starting character (a single "\n", now
  // pushed to the end), since it's not in clientText.
  updateQuill(new Delta().retain(positions.length).delete(1));
  initialDataLoaded = true;

  // Convert user inputs to DB operations.

  /**
   * Convert delta.ops into an array of modified DeltaOperations
   * having the form { index: first char index, ...DeltaOperation},
   * leaving out ops that do nothing.
   */
  function getRelevantDeltaOperations(delta: Delta): {
    index: number;
    insert?: string | object;
    delete?: number;
    attributes?: Record<string, any>;
    retain?: number;
  }[] {
    const relevantOps = [];
    let index = 0;
    for (const op of delta.ops) {
      if (op.retain === undefined || op.attributes) {
        relevantOps.push({ index, ...op });
      }
      // Adjust index for the next op.
      if (op.insert !== undefined) {
        if (typeof op.insert === "string") index += op.insert.length;
        else index += 1; // Embed
      } else if (op.retain !== undefined) index += op.retain;
      // Deletes don't add to the index because we'll do the
      // next operation after them, hence the text will already
      // be shifted left.
    }
    return relevantOps;
  }

  quill.on("text-change", (delta) => {
    // In theory we can listen for events with source "user",
    // to ignore changes caused by Collab events instead of
    // user input.  However, changes that remove formatting
    // using the "remove formatting" button, or by toggling
    // a link off, instead get emitted with source "api".
    // This appears to be fixed only on a not-yet-released v2
    // branch: https://github.com/quilljs/quill/issues/739
    // For now, we manually keep track of whether changes are due
    // to us or not.
    // if (source !== "user") return;
    if (inUpdateQuill) return;

    inQuillListener = true;
    try {
      for (const op of getRelevantDeltaOperations(delta)) {
        // Insertion
        if (op.insert) {
          if (typeof op.insert === "string") {
            // For bulk inserts, each push() (per char) will update the state
            // immediately. To prevent indices from getting confused, generate all
            // the positions before pushing anything.
            // OPT: integrate with createBetween.
            const newPositions: Position[] = [];
            let before = positions[op.index - 1];
            const after = positions[op.index];
            for (let i = 0; i < op.insert.length; i++) {
              const newPos = posSource.createBetween(before, after);
              newPositions.push(newPos);
              before = newPos;
            }

            for (let i = 0; i < op.insert.length; i++) {
              push(textRef, {
                pos: newPositions[i],
                char: op.insert.charAt(i),
                ...(op.attributes === undefined
                  ? {}
                  : { attrs: op.attributes }),
              });
            }
          } else {
            // Embed of object
            const newPos = posSource.createBetween(
              positions[op.index - 1],
              positions[op.index]
            );
            push(textRef, {
              pos: newPos,
              char: op.insert,
              ...(op.attributes === undefined ? {} : { attrs: op.attributes }),
            });
          }
        }
        // Deletion
        else if (op.delete) {
          // Note: a concurrent attr set will still write to its attr,
          // partially resurrecting this char. We detect that when reading
          // by testing if char is undefined.
          const updateArg: { [key: string]: null } = {};
          for (let i = 0; i < op.delete; i++) {
            updateArg[keys[op.index + i]] = null;
          }
          update(textRef, updateArg);
        }
        // Formatting
        else if (op.attributes && op.retain) {
          for (let i = 0; i < op.retain; i++) {
            // For max CRDT-ness, we should implement each attr value as an
            // LWWRegister. Instead, out of laziness, we will use
            // RTDB's built-in conflict resolution for set()s and
            // remove()s, which does essentially the same thing.
            for (const [attr, value] of Object.entries(op.attributes)) {
              const attrRef = ref(
                db,
                "text/" + keys[op.index + i] + "/attrs/" + attr
              );
              if (value === null) {
                // Delete attr.
                remove(attrRef);
              } else {
                set(attrRef, value);
              }
            }
          }
        }
      }
    } finally {
      inQuillListener = false;
    }
  });

  quill.enable(true);
})();
