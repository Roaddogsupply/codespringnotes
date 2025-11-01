"use client";

export default function EmptyState({ message = "No notes found." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border p-10 text-center text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
