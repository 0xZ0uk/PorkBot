import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "../../screens/home.tsx";

export const Route = createFileRoute("/_app/")({
  component: HomeScreen,
});
