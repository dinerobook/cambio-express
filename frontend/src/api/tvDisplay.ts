// TV Display API hooks. Backed by /api/v2/tv-display/*.
//
// Read: overview (settings + countries + active pairing).
// Write: settings save, public-token rotate, Fire TV claim/revoke,
//        country create/delete, country editor save (header, banks,
//        rate matrix in one PUT).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import type { components } from "./openapi";

export type TVDisplayCountryUpdateRequest =
  components["schemas"]["TVDisplayCountryUpdateRequest"];

export type TVDisplayCountryStat = components["schemas"]["TVDisplayCountryStat"];

export type TVPairingSummary = components["schemas"]["TVPairingSummary"];

export type TVDisplayOverviewResponse = components["schemas"]["TVDisplayOverviewResponse"];

export function useTVDisplayOverview() {
  return useQuery<TVDisplayOverviewResponse>({
    queryKey: ["tv-display", "overview"],
    queryFn: () => api<TVDisplayOverviewResponse>("/api/v2/tv-display/overview"),
  });
}

export interface TVDisplaySettingsUpdate {
  title: string;
  subtitle: string;
  orientation: string;
  theme: string;
}

export function useSaveTVDisplaySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TVDisplaySettingsUpdate) =>
      api("/api/v2/tv-display/settings", { method: "POST", json: payload }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}

export type TVDisplayRegenerateTokenResponse = components["schemas"]["TVDisplayRegenerateTokenResponse"];

export function useRegenerateTVDisplayToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<TVDisplayRegenerateTokenResponse>(
        "/api/v2/tv-display/regenerate-token",
        { method: "POST", json: {} },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}

export function useClaimTVPairCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      api("/api/v2/tv-display/claim", {
        method: "POST",
        json: { code },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}

export function useRevokeTVPairing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pairingId: number) =>
      api(`/api/v2/tv-display/pairings/${pairingId}/revoke`, {
        method: "POST",
        json: {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}

export interface TVDisplayCreateCountryRequest {
  country_name: string;
  country_code: string;
  mt_companies?: string;
}

export interface TVDisplayCreateCountryResponse {
  id: number;
  country_name: string;
  country_code: string;
}

export function useCreateTVDisplayCountry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TVDisplayCreateCountryRequest) =>
      api<TVDisplayCreateCountryResponse>("/api/v2/tv-display/countries", {
        method: "POST",
        json: payload,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}

export function useDeleteTVDisplayCountry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (countryId: number) =>
      api(`/api/v2/tv-display/countries/${countryId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}


// ── Country detail (banks + rate matrix) ───────────────────

export type TVDisplayBankRow = components["schemas"]["TVDisplayBankRow"];

export type TVDisplayCountryDetailResponse = components["schemas"]["TVDisplayCountryDetailResponse"];

export function useTVDisplayCountryDetail(countryId: number) {
  return useQuery<TVDisplayCountryDetailResponse>({
    queryKey: ["tv-display", "country", countryId],
    queryFn: () =>
      api<TVDisplayCountryDetailResponse>(
        `/api/v2/tv-display/countries/${countryId}`,
      ),
    enabled: countryId > 0,
  });
}

export function useUpdateTVDisplayCountry(countryId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TVDisplayCountryUpdateRequest) =>
      api<TVDisplayCountryDetailResponse>(
        `/api/v2/tv-display/countries/${countryId}`,
        { method: "PUT", json: payload },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tv-display"] }),
  });
}
