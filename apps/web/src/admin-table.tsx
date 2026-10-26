import type { ReactNode } from 'react';
import { t } from './i18n.ts';

export function AdminTable({
  label,
  columns,
  empty,
  emptyText,
  children,
}: {
  label: string;
  columns: string[];
  empty: boolean;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-table-container">
      <p className="admin-table-hint">{t('左右滑动查看全部列')}</p>
      <div
        className="admin-table-scroll"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <table
          className={`admin-table${columns.length > 5 ? ' admin-table-wide' : ''}`}
          aria-label={label}
        >
          <thead>
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={columns.length} className="admin-table-empty">
                  {emptyText}
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
