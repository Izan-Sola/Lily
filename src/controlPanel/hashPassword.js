import bcrypt from 'bcryptjs'

const password = process.argv[2]
if (!password) {
    console.error('Usage: node src/controlPanel/hashPassword.js "your password"')
    process.exit(1)
}

const hash = bcrypt.hashSync(password, 12)
console.log('\nPut this in your .env:\n')
console.log(`CP_PASSWORD_HASH=${hash}\n`)