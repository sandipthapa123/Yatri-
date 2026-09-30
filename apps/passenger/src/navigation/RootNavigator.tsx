import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';

import { EmergencyContactsScreen } from '../screens/EmergencyContactsScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { PhoneEntryScreen } from '../screens/PhoneEntryScreen';
import { PickLocationScreen } from '../screens/PickLocationScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { RequestRideScreen } from '../screens/RequestRideScreen';
import { RideHistoryScreen } from '../screens/RideHistoryScreen';
import { SavedPlacesScreen } from '../screens/SavedPlacesScreen';
import { TripTrackingScreen } from '../screens/TripTrackingScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';

export type RootStackParamList = {
  Welcome: undefined;
  PhoneEntry: undefined;
  OtpVerification: { phoneNumber: string };
  ProfileSetup: undefined;
  Home: undefined;
  Profile: undefined;
  PickLocation: { purpose: 'pickup' | 'destination' };
  SavedPlaces: undefined;
  TripTracking: { tripId: string };
  RequestRide: undefined;
  RideHistory: undefined;
  EmergencyContacts: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * One stack, two logical phases: unauthenticated screens (Welcome -> phone
 * -> OTP) or authenticated ones (optional profile setup -> Home). Swapping
 * the screen list on `status` — rather than nesting separate navigators —
 * is React Navigation's documented pattern for auth flows, and it means a
 * successful verify-otp naturally lands on the right screen with no manual
 * `navigate()` call.
 */
export function RootNavigator() {
  const { status, isNewUser } = useAuth();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={status === 'authenticated' && isNewUser ? 'ProfileSetup' : undefined}
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="ProfileSetup" component={ProfileSetupScreen} />
            <Stack.Screen name="Profile" component={ProfileScreen} />
            <Stack.Screen name="PickLocation" component={PickLocationScreen} />
            <Stack.Screen name="SavedPlaces" component={SavedPlacesScreen} />
            <Stack.Screen name="TripTracking" component={TripTrackingScreen} />
            <Stack.Screen name="RequestRide" component={RequestRideScreen} />
            <Stack.Screen name="RideHistory" component={RideHistoryScreen} />
            <Stack.Screen name="EmergencyContacts" component={EmergencyContactsScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="OtpVerification" component={OtpVerificationScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
