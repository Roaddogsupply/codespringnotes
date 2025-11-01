"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export default function NoteCard({
  note,
}: {
  note: {
    id: string;
    title: string;
    preview: string;
    updatedAt: string;
    categoryId?: string | null;
    categoryName?: string | null;
    categoryColor?: string | null;
  };
}) {
  return (
    <Link href={`/notes/${note.id}`} className="block">
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="truncate">{note.title || "Untitled"}</CardTitle>
            {note.categoryName ? (
              <Badge
                className={cn("text-xs", note.categoryColor ? "" : "bg-secondary")}
                style={note.categoryColor ? { backgroundColor: note.categoryColor } : undefined}
              >
                {note.categoryName}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p className="line-clamp-3">{note.preview}</p>
          <p className="mt-3 text-xs">
            Updated {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
