"use client";

import styles from "./DataTable.module.css";
type Row = { seller: string; quote: string; terms: string };

export function DataTable({ rows = [] }: { rows?: Row[] }) {
  return (
    <div className={styles.tbl} data-theme="dark">
      <div className={styles.tblHead}>
        {["Seller", "Quote", "Terms"].map((h) => (
          <div key={h} className={styles.tblCell}>{h}</div>
        ))}
      </div>
      <div className={styles.tblBody}>
        {rows.map((row, index) => (
          <div key={`${row.seller}-${index}`} className={styles.tblRow}>
            <div className={styles.tblCell}><span className={styles.sellerMark}>{row.seller.trim().slice(0,1).toUpperCase()}</span><span className={styles.tblCellText}>{row.seller}</span></div>
            <div className={styles.tblCell}>{row.quote}</div>
            <div className={styles.tblCell}>{row.terms || "Terms not confirmed"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
