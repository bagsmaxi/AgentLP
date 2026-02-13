'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  fetchPools,
  fetchPositions,
  fetchAnalytics,
  fetchNotifications,
  fetchUnreadCount,
  startAgent,
  stopAgent,
} from './api';

export function usePools(limit = 10, mode: 'assisted' | 'degen' = 'assisted') {
  return useQuery({
    queryKey: ['pools', limit, mode],
    queryFn: () => fetchPools(limit, mode),
  });
}

export function usePositions() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ['positions', publicKey?.toBase58()],
    queryFn: () => fetchPositions(publicKey!.toBase58()),
    enabled: !!publicKey,
    refetchInterval: 30_000,
  });
}

export function useAnalytics() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ['analytics', publicKey?.toBase58()],
    queryFn: () => fetchAnalytics(publicKey!.toBase58()),
    enabled: !!publicKey,
  });
}

export function useStartAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
  });
}

export function useStopAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: stopAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
  });
}

export function useNotifications() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ['notifications', publicKey?.toBase58()],
    queryFn: () => fetchNotifications(publicKey!.toBase58()),
    enabled: !!publicKey,
    refetchInterval: 30_000,
  });
}

export function useUnreadCount() {
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ['unreadCount', publicKey?.toBase58()],
    queryFn: () => fetchUnreadCount(publicKey!.toBase58()),
    enabled: !!publicKey,
    refetchInterval: 15_000,
  });
}
