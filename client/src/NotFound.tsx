import { Link } from "react-router";

export default function NotFound() {
  return (
    <div className="center-screen">
      <div className="card" style={{ maxWidth: 420, textAlign: "center" }}>
        <h2>Page not found</h2>
        <p className="muted" style={{ margin: "8px 0 20px" }}>
          That link doesn't lead anywhere. If you're trying to start a return,
          use the link the store sent you.
        </p>
        <Link className="btn btn--secondary" to="/admin">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
