import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { DbProduct, MatchQuality } from '../types/product';

type Platform = 'zepto' | 'blinkit';

interface Props {
  product: DbProduct | null;
  matchQuality: MatchQuality | 'unavailable';
  source: Platform;
}

const PLATFORM: Record<Platform, { activeBg: string; dimBg: string; label: string }> = {
  zepto:   { activeBg: '#7C3AED', dimBg: '#C4B5FD', label: 'Z' },
  blinkit: { activeBg: '#F59E0B', dimBg: '#FCD34D', label: 'B' },
};

const QUALITY_TAG: Partial<Record<MatchQuality, { text: string; bg: string; fg: string }>> = {
  pinned:     { text: 'Pinned',     bg: '#EFF6FF', fg: '#2563EB' },
  substitute: { text: 'Suggested',  bg: '#FFFBEB', fg: '#D97706' },
};

export default function ProductCard({ product, matchQuality, source }: Props) {
  const p = PLATFORM[source];

  if (!product || matchQuality === 'unavailable') {
    return (
      <View style={[styles.card, styles.cardNA]}>
        <View style={[styles.image, styles.imagePlaceholder]} />
        <View style={styles.info}>
          <Text style={styles.nameNA}>Not available</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: p.dimBg }]}>
          <Text style={styles.badgeText}>{p.label}</Text>
        </View>
      </View>
    );
  }

  const tag = QUALITY_TAG[matchQuality as MatchQuality];
  const hasDiscount = product.mrp > product.price;

  return (
    <View style={[styles.card, matchQuality === 'substitute' && styles.cardSubstitute]}>
      <Image
        source={{ uri: product.image_url }}
        style={styles.image}
        resizeMode="contain"
      />
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        <Text style={styles.packSize}>{product.pack_size}</Text>
        <View style={styles.priceRow}>
          <Text style={styles.price}>₹{product.price.toFixed(2)}</Text>
          {hasDiscount && (
            <Text style={styles.mrp}>₹{product.mrp.toFixed(2)}</Text>
          )}
          {tag && (
            <View style={[styles.qualityTag, { backgroundColor: tag.bg }]}>
              <Text style={[styles.qualityTagText, { color: tag.fg }]}>{tag.text}</Text>
            </View>
          )}
        </View>
      </View>
      <View style={[styles.badge, { backgroundColor: p.activeBg }]}>
        <Text style={styles.badgeText}>{p.label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    borderRadius: 8,
    marginTop: 8,
    padding: 8,
    gap: 10,
  },
  cardNA: {
    backgroundColor: '#F9FAFB',
    opacity: 0.6,
  },
  cardSubstitute: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  image: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  imagePlaceholder: {
    backgroundColor: '#E5E7EB',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 18,
  },
  nameNA: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },
  packSize: {
    fontSize: 11,
    color: '#6B7280',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  price: {
    fontSize: 14,
    fontWeight: '700',
    color: '#15803D',
  },
  mrp: {
    fontSize: 12,
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
  },
  qualityTag: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  qualityTagText: {
    fontSize: 10,
    fontWeight: '700',
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
});
