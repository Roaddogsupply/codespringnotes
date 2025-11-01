---
id: da916675-7157-4e5b-b51b-a5b0b1081d92
title: "PRD: Note Creation & Editing"
projectId: a6cd2e46-a17d-493c-8a5a-277014625f20
createdAt: 2025-10-31T21:06:31.249Z
updatedAt: 2025-10-31T21:06:31.249Z
---

## Feature: Note Creation & Editing

### Overview
Enable authenticated users to create, edit, and delete notes using a rich-text editor (TipTap). Notes are persisted in Supabase (Postgres) via Drizzle ORM. Server Actions handle all mutations with proper authorization (Clerk), validation, and error handling. The UI uses ShadCN UI and Tailwind, with smooth interactions via Framer Motion. Ephemeral editor UI state is managed with Zustand; persistent state is handled by Server Components/Actions.

### User Stories & Requirements
- As an authenticated user, I want to create a new note so that I can capture information.
  - Acceptance Criteria:
    - A “New Note” page loads with an empty title field and TipTap editor initialized with StarterKit.
    - User can type and format text (bold, italic, headings, bullet/numbered list).
    - Save button persists the note and redirects to the note detail page or shows a success toast.
    - Title is required (min 1 char, max 200 chars).
    - Content can be empty but must be valid TipTap JSON.

- As an authenticated user, I want to edit an existing note so that I can update information.
  - Acceptance Criteria:
    - Opening an existing note loads title and content from the database.
    - Save button is disabled until changes are detected (dirty state).
    - On save, existing note is updated; success is confirmed via toast/indicator.
    - If another update was saved concurrently, user sees a conflict error and is prompted to reload.

- As an authenticated user, I want to delete a note so that I can remove information I no longer need.
  - Acceptance Criteria:
    - Delete is behind a confirmation modal.
    - Deleting returns the user to the notes list page and revalidates cache.
    - Deleted notes are soft-deleted (deletedAt set) and do not appear in the list.

- As an authenticated user, I should not be able to access or mutate another user’s notes.
  - Acceptance Criteria:
    - Server actions validate user ownership and return 404/403 if unauthorized.

### Technical Implementation

#### Database Schema
Provide the Drizzle ORM schema ONLY for tables needed by this feature.

```typescript
// /db/schema/notes.ts
import { pgTable, uuid, varchar, jsonb, text, timestamp, index } from 'drizzle-orm/pg-core';

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: varchar('user_id', { length: 255 }).notNull(), // Clerk user ID
    title: varchar('title', { length: 200 }).notNull(),
    // TipTap/ProseMirror JSON document
    content: jsonb('content').notNull(), // $type<unknown>() optional if you want stricter typing
    // Optional cached HTML representation for faster read-only rendering (not required for MVP UI)
    contentHtml: text('content_html'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('notes_user_idx').on(table.userId),
    userUpdatedIdx: index('notes_user_updated_idx').on(table.userId, table.updatedAt),
  })
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
```

Notes:
- updatedAt should be set in server actions on each update (Postgres doesn’t auto-update).
- Soft delete via deletedAt; queries should always filter deletedAt IS NULL.

#### API Endpoints / Server Actions
All mutations and secure reads use Server Actions with Clerk auth checks. Revalidate pages where necessary.

```typescript
// /app/(dashboard)/notes/actions.ts
'use server';

import { auth } from '@clerk/nextjs';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { notes } from '@/db/schema/notes';
import { eq, and, isNull } from 'drizzle-orm';

const ContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough(); // Accept TipTap JSON structure

const CreateNoteSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.any().refine((v) => ContentSchema.safeParse(v).success, 'Invalid editor content'),
  // Optional: cached HTML if you plan to render outside editor; ensure it’s sanitized before saving
  contentHtml: z.string().max(500000).optional(), // ~500KB cap
});

const UpdateNoteSchema = CreateNoteSchema.extend({
  id: z.string().uuid(),
  // Optimistic concurrency control
  lastUpdatedAt: z.string().datetime(), // ISO string from client
});

const DeleteNoteSchema = z.object({
  id: z.string().uuid(),
});

type ActionResult<T> =
  | { status: 'success'; data: T }
  | { status: 'error'; code: string; message: string };

export async function createNote(input: z.infer<typeof CreateNoteSchema>): Promise<ActionResult<{ id: string }>> {
  const { userId } = auth();
  if (!userId) return { status: 'error', code: 'UNAUTHENTICATED', message: 'Sign in required' };

  const parsed = CreateNoteSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'VALIDATION_ERROR', message: parsed.error.message };

  try {
    const now = new Date();
    const [row] = await db
      .insert(notes)
      .values({
        userId,
        title: parsed.data.title.trim(),
        content: parsed.data.content,
        contentHtml: parsed.data.contentHtml ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: notes.id });

    revalidatePath('/notes'); // Adjust to your list route
    return { status: 'success', data: { id: row.id } };
  } catch (e: any) {
    return { status: 'error', code: 'DB_ERROR', message: 'Failed to create note' };
  }
}

export async function updateNote(input: z.infer<typeof UpdateNoteSchema>): Promise<ActionResult<{ id: string }>> {
  const { userId } = auth();
  if (!userId) return { status: 'error', code: 'UNAUTHENTICATED', message: 'Sign in required' };

  const parsed = UpdateNoteSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'VALIDATION_ERROR', message: parsed.error.message };

  try {
    // Fetch current for ownership and concurrency check
    const [existing] = await db
      .select({ id: notes.id, updatedAt: notes.updatedAt })
      .from(notes)
      .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, userId), isNull(notes.deletedAt)));

    if (!existing) return { status: 'error', code: 'NOT_FOUND', message: 'Note not found' };

    const clientUpdatedAt = new Date(parsed.data.lastUpdatedAt).getTime();
    const serverUpdatedAt = new Date(existing.updatedAt).getTime();
    if (serverUpdatedAt !== clientUpdatedAt) {
      return { status: 'error', code: 'CONFLICT', message: 'The note was updated elsewhere. Please reload.' };
    }

    const now = new Date();
    await db
      .update(notes)
      .set({
        title: parsed.data.title.trim(),
        content: parsed.data.content,
        contentHtml: parsed.data.contentHtml ?? null,
        updatedAt: now,
      })
      .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, userId), isNull(notes.deletedAt)));

    revalidatePath('/notes');
    revalidatePath(`/notes/${parsed.data.id}`);
    return { status: 'success', data: { id: parsed.data.id } };
  } catch (e: any) {
    return { status: 'error', code: 'DB_ERROR', message: 'Failed to update note' };
  }
}

export async function deleteNote(input: z.infer<typeof DeleteNoteSchema>): Promise<ActionResult<{ id: string }>> {
  const { userId } = auth();
  if (!userId) return { status: 'error', code: 'UNAUTHENTICATED', message: 'Sign in required' };

  const parsed = DeleteNoteSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'VALIDATION_ERROR', message: parsed.error.message };

  try {
    const now = new Date();
    const res = await db
      .update(notes)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, userId), isNull(notes.deletedAt)))
      .returning({ id: notes.id });

    if (!res.length) return { status: 'error', code: 'NOT_FOUND', message: 'Note not found' };

    revalidatePath('/notes');
    return { status: 'success', data: { id: res[0].id } };
  } catch (e: any) {
    return { status: 'error', code: 'DB_ERROR', message: 'Failed to delete note' };
  }
}

// Optional: secure server-side fetch
export async function getNoteById(id: string): Promise<ActionResult<{ id: string; title: string; content: unknown; updatedAt: string }>> {
  const { userId } = auth();
  if (!userId) return { status: 'error', code: 'UNAUTHENTICATED', message: 'Sign in required' };

  try {
    const [row] = await db
      .select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)));
    if (!row) return { status: 'error', code: 'NOT_FOUND', message: 'Note not found' };
    return {
      status: 'success',
      data: { id: row.id, title: row.title, content: row.content, updatedAt: row.updatedAt.toISOString() },
    };
  } catch {
    return { status: 'error', code: 'DB_ERROR', message: 'Failed to fetch note' };
  }
}
```

#### Components Structure
Describe the component hierarchy and key components:

```
/app/(dashboard)/notes/
├── new/page.tsx                // Server Component: renders NoteEditorPage in "create" mode
├── [id]/page.tsx               // Server Component: renders NoteEditorPage in "edit" mode
├── actions.ts                  // Server Actions (see above)
└── _components/
    ├── note-editor.tsx         // Client: TipTap editor + toolbar + Save/Delete
    ├── note-toolbar.tsx        // Client: formatting buttons (bold, italic, headings, lists)
    ├── delete-note-dialog.tsx  // Client: ShadCN Dialog for delete confirmation
    └── title-input.tsx         // Client: ShadCN Input for title
```

Key files (implementation outline):

```tsx
// /app/(dashboard)/notes/new/page.tsx
import NoteEditor from '../_components/note-editor';

export default function NewNotePage() {
  // No initial data; create mode
  return <NoteEditor mode="create" />;
}
```

```tsx
// /app/(dashboard)/notes/[id]/page.tsx
import { getNoteById } from '../actions';
import NoteEditor from '../_components/note-editor';

export default async function EditNotePage({ params }: { params: { id: string } }) {
  const res = await getNoteById(params.id);
  if (res.status === 'error') {
    // You may render not-found or an error boundary
    return null;
  }
  return <NoteEditor mode="edit" initialNote={res.data} />;
}
```

```tsx
// /app/(dashboard)/notes/_components/note-editor.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button, Input } from '@/components/ui'; // ShadCN re-exports
import { createNote, updateNote, deleteNote } from '../actions';
import { useEditorStore } from '@/stores/editor-store';
import NoteToolbar from './note-toolbar';
import DeleteNoteDialog from './delete-note-dialog';
import { useRouter } from 'next/navigation';

type NoteEditorProps =
  | { mode: 'create'; initialNote?: never }
  | { mode: 'edit'; initialNote: { id: string; title: string; content: any; updatedAt: string } };

export default function NoteEditor(props: NoteEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(props.mode === 'edit' ? props.initialNote.title : '');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(props.mode === 'edit' ? props.initialNote.updatedAt : new Date().toISOString());
  const [saving, setSaving] = useState(false);
  const [openDelete, setOpenDelete] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: props.mode === 'edit' ? props.initialNote.content : { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: () => useEditorStore.getState().setDirty(true),
    editorProps: { attributes: { class: 'prose max-w-none focus:outline-none min-h-[200px] p-3' } },
  });

  const isDirty = useEditorStore((s) => s.isDirty);
  const setDirty = useEditorStore((s) => s.setDirty);

  useEffect(() => {
    setDirty(false);
  }, [setDirty]);

  const onSave = useCallback(async () => {
    if (!editor) return;
    setSaving(true);
    const content = editor.getJSON();

    try {
      if (props.mode === 'create') {
        const res = await createNote({ title, content });
        if (res.status === 'success') {
          setDirty(false);
          router.replace(`/notes/${res.data.id}`);
        } else {
          // Surface error to user via toast
        }
      } else {
        const res = await updateNote({ id: props.initialNote.id, title, content, lastUpdatedAt });
        if (res.status === 'success') {
          setDirty(false);
          setLastUpdatedAt(new Date().toISOString());
        } else if (res.code === 'CONFLICT') {
          // Show conflict prompt: reload current route
        } else {
          // Show generic error
        }
      }
    } finally {
      setSaving(false);
    }
  }, [editor, title, props, lastUpdatedAt, router, setDirty]);

  const onDelete = async () => {
    if (props.mode !== 'edit') return;
    const res = await deleteNote({ id: props.initialNote.id });
    if (res.status === 'success') router.replace('/notes');
  };

  // Warn before navigation if dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          placeholder="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            useEditorStore.getState().setDirty(true);
          }}
          className="text-xl font-semibold"
        />
        <div className="ml-auto flex items-center gap-2">
          {props.mode === 'edit' && (
            <Button variant="destructive" onClick={() => setOpenDelete(true)}>
              Delete
            </Button>
          )}
          <Button onClick={onSave} disabled={saving || title.trim().length === 0 || !isDirty}>
            {props.mode === 'create' ? 'Save' : 'Save changes'}
          </Button>
        </div>
      </div>

      <NoteToolbar editor={editor} />
      <div className="rounded-md border p-2">
        <EditorContent editor={editor} />
      </div>

      <DeleteNoteDialog open={openDelete} onOpenChange={setOpenDelete} onConfirm={onDelete} />
    </div>
  );
}
```

```tsx
// /app/(dashboard)/notes/_components/note-toolbar.tsx
'use client';

import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui';

export default function NoteToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={editor.isActive('bold') ? 'default' : 'secondary'} onClick={() => editor.chain().focus().toggleBold().run()}>
        Bold
      </Button>
      <Button size="sm" variant={editor.isActive('italic') ? 'default' : 'secondary'} onClick={() => editor.chain().focus().toggleItalic().run()}>
        Italic
      </Button>
      <Button size="sm" onClick={() => editor.chain().focus().toggleBulletList().run()}>Bulleted</Button>
      <Button size="sm" onClick={() => editor.chain().focus().toggleOrderedList().run()}>Numbered</Button>
      <Button size="sm" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Button>
      <Button size="sm" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Button>
    </div>
  );
}
```

```tsx
// /app/(dashboard)/notes/_components/delete-note-dialog.tsx
'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export default function DeleteNoteDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this note?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">This action can be undone by an admin only if hard-delete is not used. Continue?</p>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

#### State Management
- Editor/UI state:
  - use TipTap’s internal state for document model.
  - Zustand store to track dirty state, saving status, and to coordinate toolbar/keyboard shortcuts.

```typescript
// /stores/editor-store.ts
import { create } from 'zustand';

type EditorState = {
  isDirty: boolean;
  setDirty: (v: boolean) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  isDirty: false,
  setDirty: (v) => set({ isDirty: v }),
}));
```

- Persistent data:
  - Read in Server Components (pages) using server actions for secure authorization, pass as props to client components.
  - Mutations via server actions; use revalidatePath to update related pages.
- Optional: useFormState for action result handling on forms; here direct invocation is sufficient.

### Dependencies & Integrations
- Integrations:
  - Clerk.dev: enforce authenticated access and user ownership in server actions.
  - Supabase + Drizzle: persistence for notes; use provided db client in CodeSpring boilerplate.
  - ShadCN UI: Input, Button, Dialog for a11y-compliant UI.
  - Framer Motion: Optional micro-animations on editor mount or toasts (can be added to NoteEditor container).
- External npm packages beyond CodeSpring:
  - @tiptap/react
  - @tiptap/starter-kit
  - @tiptap/extension-placeholder (optional)
  - zustand
  - zod (if not already included in boilerplate)
  - Optional for sanitization if saving HTML: sanitize-html

### Implementation Steps
1. Create database schema
   - Add /db/schema/notes.ts (as above).
   - Generate and run Drizzle migration to create notes table and indexes.
2. Generate queries
   - No separate repository required; use Drizzle operations in server actions.
3. Implement server actions
   - Add /app/(dashboard)/notes/actions.ts with createNote, updateNote, deleteNote, getNoteById.
   - Ensure auth checks and ownership validation, concurrency control via lastUpdatedAt.
4. Build UI components
   - Implement NoteEditor, NoteToolbar, DeleteNoteDialog, TitleInput if preferred.
5. Connect frontend to backend
   - NewNotePage uses NoteEditor in create mode.
   - EditNotePage loads data via getNoteById and passes to NoteEditor in edit mode.
   - Invoke server actions from client component handlers.
6. Add error handling
   - Validate inputs with Zod; disable Save if invalid.
   - Show toasts/snackbars on success/error; handle CONFLICT errors with a reload prompt.
   - Protect navigation with beforeunload if dirty.
7. Test the feature
   - Unit test server actions (auth, ownership, validation).
   - Integration tests for create/edit/delete flows.
   - UAT scripts to verify acceptance criteria.

### Edge Cases & Error Handling
- Unauthenticated user attempts mutation/read:
  - Server actions return UNAUTHENTICATED; redirect to sign-in in routing layer as needed.
- Accessing another user’s note:
  - Return NOT_FOUND/403; do not leak existence of resource.
- Title validation:
  - Empty or >200 chars rejected; inline error displayed.
- Invalid TipTap JSON:
  - Validation error from Zod; block save.
- Oversized content/HTML:
  - Enforce size caps (e.g., 1MB JSON, 500KB HTML); return VALIDATION_ERROR.
- Concurrent edits:
  - Compare lastUpdatedAt; if mismatch, return CONFLICT; show prompt to reload/merge.
- Deleting an already-deleted or non-existent note:
  - Return NOT_FOUND; show “Note not found or already deleted.”
- Network/server errors:
  - Show generic error; keep changes in editor; allow retry.
- Navigation with unsaved changes:
  - beforeunload warning; consider in-app prompt on route change if using next/navigation events.

### Testing Approach
- Unit tests
  - Zod schemas: valid/invalid title, content structure, HTML size.
  - Server actions:
    - createNote: success, unauthenticated, validation error, DB error.
    - updateNote: success, unauthenticated, ownership violation, not found, conflict, DB error.
    - deleteNote: success, unauthenticated, ownership violation, not found, DB error.
- Integration tests (Playwright)
  - Create note:
    - Navigate to /notes/new, enter title/content, save, redirected to /notes/:id, note persists after refresh.
  - Edit note:
    - Open existing note, change title/content, save, see success, data persists after refresh.
  - Delete note:
    - Open existing note, click delete, confirm, redirected to /notes, note no longer listed.
  - Authorization:
    - User A cannot open or mutate User B’s note; see not found.
- User acceptance tests
  - Editor formatting works (bold, italic, headings, lists).
  - Save disabled until dirty and title present.
  - Confirmation modal appears on delete.
  - Conflict scenario presents reload prompt when simulated.

Notes:
- Deployment on Vercel: Ensure server actions are enabled. Use environment variables for Supabase and Clerk as in CodeSpring boilerplate.
- Security: Never trust client-provided userId; always derive from Clerk auth in server actions. Always filter deletedAt IS NULL for reads. If storing contentHtml, sanitize before persisting.


