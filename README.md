# SmartPricer 🛒

> Cross-platform mobile grocery comparison engine aggregating real-time supermarket pricing feeds.

## Overview
SmartPricer tracks fluctuating grocery prices across vendors, executes real-time product search, and reconciles heterogeneous catalog items using client-side fuzzy title-matching heuristics and asynchronous cloud sync.

## Key Features
- **Cross-Platform Client**: Built with React Native and Expo for fast catalog rendering and responsive search filtering.
- **Fuzzy Title Reconciliation**: Custom string metric heuristics (Jaro-Winkler / Levenshtein distance) resolving disparate merchant SKU formats without external package overhead.
- **Persistent Cloud Backend**: Integrated with Supabase PostgreSQL leveraging Row-Level Security (RLS) data policies.
- **Optimized UI State**: Decoupled state management minimizing unnecessary component re-renders during high-volume catalog queries.

## Tech Stack
- **Frontend**: React Native, Expo, TypeScript
- **Backend / DB**: Supabase, PostgreSQL
- **Algorithms**: String metric fuzzy title matching
