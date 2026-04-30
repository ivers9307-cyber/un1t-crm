import { redirect } from 'next/navigation'

export default function CarsIndex() {
  redirect('/cars/new')
}
