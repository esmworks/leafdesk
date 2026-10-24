"use client";

import { createContext, useContext } from "react";

/**
 * What a row's page (components/page/page-view) offers the row's properties above its body
 * (components/database/row-properties): to say that the database shows them beside the body
 * (lib/row-layout), and then the column to draw them in, beside the body where the page is wide
 * enough and above it where it isn't. Null outside a page that has one.
 */
export type RowLayoutHost = { setBeside: (beside: boolean) => void; aside: HTMLElement | null };

export const RowLayoutContext = createContext<RowLayoutHost | null>(null);

export const useRowLayoutHost = () => useContext(RowLayoutContext);
