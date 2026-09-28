import { invalid } from './errors.js';
import { decimal, minor, sum, taxAmount } from './money.js';
export type TaxComponent = 'IGST' | 'CGST' | 'SGST' | 'SERVICE_TAX';
export type TaxTreatment = 'TAXABLE' | 'NON_TAXABLE' | 'EXEMPT' | 'NIL_RATED';
export interface LineInput {
  description: string;
  amount: string;
  taxTreatment: TaxTreatment;
  taxComponents: TaxComponent[];
}
export interface AppliedTax {
  ruleId: string;
  component: TaxComponent;
  rate: string;
  amount: string;
}
export interface CalculatedLine {
  position: number;
  description: string;
  amount: string;
  taxTreatment: TaxTreatment;
  taxes: AppliedTax[];
  taxAmount: string;
  total: string;
}
export interface Rate {
  id: string;
  component: TaxComponent;
  rate: string;
  serviceCategoryId: string | null;
}
export function calculateLines(
  lines: readonly LineInput[],
  rates: readonly Rate[],
  serviceCategoryId: string,
): CalculatedLine[] {
  if (lines.length === 0 || lines.length > 200)
    throw invalid('An invoice needs between 1 and 200 lines');
  return lines.map((line, index) => {
    if (!line.description.trim()) throw invalid('Service description cannot be blank');
    minor(line.amount);
    const components = line.taxComponents;
    if (new Set(components).size !== components.length)
      throw invalid('A tax component cannot be applied twice to one line');
    if (line.taxTreatment === 'TAXABLE' && components.length === 0)
      throw invalid('Select taxes for every taxable line');
    if (line.taxTreatment !== 'TAXABLE' && components.length > 0)
      throw invalid('Only taxable lines can have tax components');
    if (components.includes('IGST') && (components.includes('CGST') || components.includes('SGST')))
      throw invalid('IGST cannot be combined with CGST or SGST on the same line');
    if (components.includes('CGST') !== components.includes('SGST'))
      throw invalid('Select CGST and SGST together');
    if (components.includes('SERVICE_TAX'))
      throw invalid('Legacy service tax is import-only; it cannot be charged on new invoices');
    const taxes = components.map((component) => {
      const candidates = rates.filter(
        (rate) =>
          rate.component === component &&
          (rate.serviceCategoryId === null || rate.serviceCategoryId === serviceCategoryId),
      );
      const specific = candidates.filter((rate) => rate.serviceCategoryId === serviceCategoryId);
      const matches = specific.length ? specific : candidates;
      if (matches.length !== 1)
        throw invalid(`Expected one applicable ${component} rate; found ${matches.length}`);
      const rate = matches[0]!;
      return {
        ruleId: rate.id,
        component,
        rate: rate.rate,
        amount: taxAmount(line.amount, rate.rate),
      };
    });
    const tax = sum(taxes.map((t) => t.amount));
    return {
      position: index + 1,
      description: line.description.trim(),
      amount: line.amount,
      taxTreatment: line.taxTreatment,
      taxes,
      taxAmount: tax,
      total: decimal(minor(line.amount) + minor(tax)),
    };
  });
}
export function invoiceTotals(lines: readonly CalculatedLine[]) {
  return {
    subtotal: sum(lines.map((l) => l.amount)),
    taxTotal: sum(lines.map((l) => l.taxAmount)),
    grandTotal: sum(lines.map((l) => l.total)),
  };
}
export function outstanding(total: string, received: string, adjustments: string): string {
  const balance = minor(total) - minor(received) - minor(adjustments);
  if (balance < 0n) throw invalid('The settlement exceeds the outstanding invoice amount');
  return decimal(balance);
}
