import { createRoot } from "react-dom/client";
import { FoundationNotice } from "@repoready/ui";
const root = document.getElementById("root");
if (!root) throw new Error("Application root missing");
createRoot(root).render(<FoundationNotice />);
