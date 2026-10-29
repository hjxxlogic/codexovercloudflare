import { Children, useState, type ReactNode } from 'react';
import { t, localeTag } from './i18n.ts';

export type TableSort = { column: number; descending: boolean };
export type SortValue = string | number | undefined;

export function compareRows(a: SortValue[], b: SortValue[], sort: TableSort) {
  const left = a[sort.column],
    right = b[sort.column];
  // Unknown timestamps stay below known values in both directions.
  if (left === undefined || right === undefined)
    return left === right ? 0 : left === undefined ? 1 : -1;
  const result =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), localeTag(), {
          numeric: true,
        });
  return (
    (sort.descending ? -result : result) ||
    String(a[0]).localeCompare(String(b[0]), localeTag(), { numeric: true })
  );
}

export function AdminTable({
  label,
  columns,
  empty,
  emptyText,
  children,
  rowValues,
  sort: controlledSort,
  onSort,
}: {
  label: string;
  columns: string[];
  empty: boolean;
  emptyText: string;
  children: ReactNode;
  rowValues: SortValue[][];
  sort?: TableSort;
  onSort?: (sort: TableSort) => void;
}) {
  const [localSort, setLocalSort] = useState<TableSort>();
  const sort = controlledSort ?? localSort;
  const rows = Children.toArray(children).map((node, index) => ({
    node,
    values: rowValues[index] || [],
  }));
  if (sort) rows.sort((a, b) => compareRows(a.values, b.values, sort));
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
              {columns.map((column, index) => (
                <th
                  scope="col"
                  key={column}
                  aria-sort={
                    sort?.column === index
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className="admin-sort"
                    onClick={() => {
                      const next = {
                        column: index,
                        descending:
                          sort?.column === index ? !sort.descending : false,
                      };
                      if (onSort) onSort(next);
                      else setLocalSort(next);
                    }}
                  >
                    {column}{' '}
                    <span aria-hidden="true">
                      {sort?.column === index
                        ? sort.descending
                          ? '▼'
                          : '▲'
                        : '↕'}
                    </span>
                  </button>
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
              rows.map((row) => row.node)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
