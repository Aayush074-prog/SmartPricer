import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import WarmWebViewManager from './src/components/WarmWebViewManager';
import RootNavigator from './src/navigation/RootNavigator';
import { BasketProvider } from './src/context/BasketContext';

export default function App() {
  return (
    <BasketProvider>
      <View style={styles.root}>
        {/* Singleton off-screen WebView — must stay mounted for the lifetime of the app. */}
        <WarmWebViewManager />

        <NavigationContainer style={styles.navigator}>
          <StatusBar style="auto" />
          <RootNavigator />
        </NavigationContainer>
      </View>
    </BasketProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  navigator: { flex: 1 },
});
