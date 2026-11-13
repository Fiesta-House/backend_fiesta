import prisma from '../../config/prisma';
import {
  MINIMUM_BOOKING_DEPOSIT,
  PACKAGE_NAMES_FOR_EXTRACTION,
} from '../../config/constants';

export async function getPackageForDeposit(
  packageName?: string
): Promise<{ name: string; deposit: number | null } | null> {
  if (!packageName) {
    return prisma.package.findFirst({
      where: { name: { in: [...PACKAGE_NAMES_FOR_EXTRACTION] } },
      orderBy: { deposit: 'asc' },
      select: { name: true, deposit: true },
    });
  }

  const normalizedName = packageName.trim().toLowerCase()
    .replace(/\s+(?:package|edition)$/i, '');

  const canonicalName = PACKAGE_NAMES_FOR_EXTRACTION.find((name) => {
    const normalizedPackageName = name.toLowerCase();

    return normalizedPackageName === normalizedName
      || normalizedPackageName.replace(/^the\s+/, '') === normalizedName;
  }) || packageName.trim();

  return prisma.package.findUnique({
    where: { name: canonicalName },
    select: { name: true, deposit: true },
  });
}

export function getDepositForPackage(
  pkg: { name: string; deposit: number | null } | null | undefined
): number {
  if (!pkg) {
    throw new Error('No package deposit is configured. Ask the studio team to confirm the amount.');
  }

  const isProductionMpesa =
    (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase() === 'production';

  const localOverride = Number(process.env.LOCAL_DEPOSIT_OVERRIDE);

  const depositAmount: unknown =
    !isProductionMpesa
    && process.env.NODE_ENV !== 'production'
    && !process.env.NODE_TEST_CONTEXT
    && Number.isInteger(localOverride)
    && localOverride > 0
      ? localOverride
      : pkg.deposit;

  if (
    typeof depositAmount !== 'number'
    || !Number.isInteger(depositAmount)
    || depositAmount < 1
  ) {
    throw new Error(
      `The configured deposit for ${pkg.name} is missing or invalid. Do not quote or initiate payment; ask the studio team to correct package pricing.`
    );
  }

  if (isProductionMpesa && depositAmount < MINIMUM_BOOKING_DEPOSIT) {
    throw new Error(
      `The configured booking deposit is below the KSh ${MINIMUM_BOOKING_DEPOSIT.toLocaleString()} minimum. Do not initiate payment; ask the studio team to correct package pricing.`
    );
  }

  return depositAmount;
}