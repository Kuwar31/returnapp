export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="alert alert--error">{message}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="center-screen">
      <p className="muted">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
