"use server";

import "server-only";
import {
    registrationValidator,
    LoginFormSchema,
} from "../supabase/auth/schemas";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/supabase/server";

import { db } from "@/db";
import { Users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { HOST_URL } from "@/utils/constants";

import { Resend } from "resend";
import { supabase } from "@/app/supabaseClient";

export async function login(state: { error: string }, formData: FormData) {
    const supabase = await createClient();

    const data = {
        email: formData.get("email") as string,
        password: formData.get("password") as string,
    };

    // Validate the login data
    const loginValidation = LoginFormSchema.safeParse(data);
    if (!loginValidation.success) {
        return {
            error: loginValidation.error.errors
                .map((e) => e.message)
                .join(", "),
        };
    }

    const { email, password } = loginValidation.data;

    // Check if user is disabled
    const dbUser = await db.select().from(Users).where(eq(Users.email, email));
    if (dbUser.length > 0 && dbUser[0].isDisabled) {
        // redirect(
        //     `/login?error=${encodeURIComponent(
        //         "Your account has been disabled. Please contact support."
        //     )}`
        // );

        return {
            error: "Your account has been disabled. Please contact support.",
        };
    }

    const { error, data: user } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        return { error: error.message }; // Return the error message instead of redirecting
    }

    try {
        await db
            .update(Users)
            .set({ lastLogin: sql`NOW()` })
            .where(eq(Users.userId, user.user.id));
    } catch (error) {
        console.error(error);
    }

    revalidatePath("/", "layout");
    redirect("/");
}

export async function signup(formData: FormData) {
    const supabase = await createClient();

    const data = {
        email: formData.get("email") as string,
        password: formData.get("password") as string,
        confirmPassword: formData.get("confirmPassword") as string,
        full_name: formData.get("fullName") as string,
    };

    // Validate the signup data
    const registrationValidation = registrationValidator.safeParse(data);
    if (!registrationValidation.success) {
        return {
            error: registrationValidation.error.errors
                .map((e) => e.message)
                .join(", "),
        };
    }

    const { email, password, confirmPassword, full_name } =
        registrationValidation.data;

    if (password !== confirmPassword) {
        return {
            error: "Password and Confirm Password must match.",
        };
    }

    const { error, data: retData } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                full_name,
            },
        },
    });

    if (error) {
        return { error: error.message };
    }

    // check if any admin exists in the user table

    const response = await db.$count(Users, eq(Users.role, "admin"));
    try {
        await db.insert(Users).values({
            userId: retData?.user?.id as string,
            email: email,
            name: full_name,
            role: response ? "guest" : "admin",
            createdAt: new Date(),
            updatedAt: new Date(),
            lastLogin: undefined,
        });
    } catch {
        return {
            error: "Unknown error occurred",
        };
    }

    // Add to resend contacts if they are staff
    // if (response) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    resend.contacts.create({
        email: email,
        firstName: full_name.split(" ")[0],
        lastName: full_name.split(" ")[1],
        unsubscribed: false,
        audienceId: process.env.RESEND_AUDIENCE_ID!,
    });
    // }
    return { error: null };
}

export async function signOut() {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    if (!error) {
        revalidatePath("/login", "page");
        redirect("/login");
    }
    return error;
}

export async function GoogleLogin() {
    const supabase = await createClient();

    // Get the user's email from the session if they're already signed in
    const { data: session } = await supabase.auth.getSession();
    if (session?.session?.user?.email) {
        // Check if user is disabled
        const dbUser = await db
            .select()
            .from(Users)
            .where(eq(Users.email, session.session.user.email));
        if (dbUser.length > 0 && dbUser[0].isDisabled) {
            // Sign them out if they're disabled
            await supabase.auth.signOut();
            redirect(
                "/login?error=Your account has been disabled. Please contact support."
            );
        }
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo: `${HOST_URL}/auth/callback`,
        },
    });

    if (error) {
        console.error("Error occurred", error);
        redirect("/login?error=" + encodeURIComponent(error.message));
    }

    if (data.url) {
        redirect(data.url);
    }
}

export async function LoggedInOrRedirectToLogin() {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
        redirect("/login");
    }
    return data;
}

// New function combining auth check and role query
export async function getUserDataAndRole() {
    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.getUser();

    if (authError || !authData?.user) {
        redirect("/login");
    }

    // Immediately query for the role after getting the user
    try {
        const userRecord = await db
            .select({ role: Users.role })
            .from(Users)
            .where(eq(Users.userId, authData.user.id));

        if (!userRecord || userRecord.length === 0) {
            // Handle case where user exists in auth but not in Users table (should ideally not happen)
            console.error(`User ${authData.user.id} found in auth but not in Users table.`);
            redirect("/login?error=User data inconsistent. Please contact support.");
        }

        return {
            user: authData.user,
            role: userRecord[0].role as "admin" | "staff" | "broker" | "customer" | "guest", // Add type assertion if needed
        };

    } catch (dbError) {
        console.error("Database error fetching user role:", dbError);
        redirect("/login?error=Failed to retrieve user details.");
    }
}


export async function UserInfo(userId: string) {
    return db.select().from(Users).where(eq(Users.userId, userId));
}

export async function IsGuest(userId: string) {
    const user = await db.select().from(Users).where(eq(Users.userId, userId));
    // Keep IsGuest for potential other uses, but avoid calling it in page load sequence
    return user[0].role === "guest";
}

export async function isAdmin(userId: string) {
    const user = await db.select().from(Users).where(eq(Users.userId, userId));
    return user[0].role === "admin";
}

export async function resetUserPassword(email: string) {
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${HOST_URL}/auth/callback`,
    });

    if (error) {
        throw new Error(error.message);
    }

    return { success: true };
}

export async function restrictUserAccess(userId: string) {
    try {
        await db
            .update(Users)
            .set({ isDisabled: true })
            .where(eq(Users.userId, userId));

        revalidatePath("/users");
        return { success: true };
    } catch (error) {
        throw new Error(
            error instanceof Error
                ? error.message
                : "Failed to restrict user access"
        );
    }
}

export async function enableUserAccess(userId: string) {
    try {
        await db
            .update(Users)
            .set({ isDisabled: false })
            .where(eq(Users.userId, userId));

        revalidatePath("/users");
        return { success: true };
    } catch (error) {
        throw new Error(
            error instanceof Error
                ? error.message
                : "Failed to enable user access"
        );
    }
}

export async function createUser(
    name: string,
    email: string,
    role: "broker" | "customer" | "admin" | "staff" | "guest"
) {
    try {
        // Use the admin client with service role key for admin operations
        // const supabase = await createAdminClient();
        const supabase = await createClient();

        // Generate a random password for the user
        const tempPassword = Math.random().toString(36).slice(-8);

        // Create the user in Supabase Auth
        // const { data: authData, error: authError } =
        //     await supabase.auth.admin.inviteUserByEmail(email);

        const { error: authError, data: authData } = await supabase.auth.signUp(
            {
                email,
                password: tempPassword,
                options: {
                    data: {
                        full_name: name,
                    },
                },
            }
        );

        if (authError) {
            throw new Error(
                `Failed to create user in auth: ${authError.message}`
            );
        }

        if (!authData.user) {
            throw new Error("User creation failed: No user returned from auth");
        }

        // Insert the user into our database
        await db.insert(Users).values({
            userId: authData.user.id,
            name: name,
            email: email,
            role: role,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Send welcome email with temporary password
        const resend = new Resend(process.env.RESEND_API_KEY);

        // if (role === "staff" || role === "admin") {
        resend.contacts.create({
            email: email,
            firstName: name.split(" ")[0],
            lastName: name.split(" ")[1],
            unsubscribed: false,
            audienceId: process.env.RESEND_AUDIENCE_ID!,
        });
        // }

        const { error: emailError } = await resend.emails.send({
            from: "onboarding@fire-erp.enclave.live",
            to: email,
            subject: "Welcome to Fire ERP",
            html: `<p>Your account has been created successfully!</p>
                <p>Your temporary password is: <strong style="color: #007bff;">${tempPassword}</strong></p>
                <p>Please check for another email for the verification link to activate your account.</p>
                <p>After logging in, make sure to change your password for security reasons.</p>`,
        });

        if (emailError) {
            console.error("Failed to send welcome email:", emailError);
            // Continue even if email fails since user creation succeeded
        }

        return {
            success: true,
            message: "User created successfully",
            userId: authData.user.id,
        };
    } catch (error) {
        return {
            success: false,
            message:
                error instanceof Error
                    ? error.message
                    : "Failed to create user",
        };
    }
}

export async function deleteUser(userId: string) {
    const user = await db.select().from(Users).where(eq(Users.userId, userId));
    // remove from resend
    const resend = new Resend(process.env.RESEND_API_KEY);
    resend.contacts.remove({
        email: user[0].email,
        audienceId: process.env.RESEND_AUDIENCE_ID!,
    });
    // remove from auth
    await supabase.auth.admin.deleteUser(userId);
    // remove from users table
    await db.delete(Users).where(eq(Users.userId, userId));
    revalidatePath("/users");
    return { success: true };
}
